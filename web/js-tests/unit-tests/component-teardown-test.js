//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * What a component leaves behind when it leaves the document, and what it
 * picks up again when it comes back.
 *
 * - A tool-action tile removed from its column on its own (thread navigation,
 *   a delete, tool grouping) must stop observing the thread's array. Its
 *   teardown used to find that array through `closest('conversation-area')`,
 *   which a removed element can no longer answer, so each such tile left an
 *   observer running on every change to the thread for as long as the
 *   conversation stayed open.
 * - A path completion that arrives after its field was closed or removed must
 *   not open a menu: the menu is portaled to <body> with window listeners of
 *   its own, and nothing would ever close it.
 * - A permission control moved to another parent (the composer re-parents it
 *   when the pointer type changes) must keep listening to its thread, which it
 *   stays bound to across the move. So must a strategy selector, which observes
 *   the conversation's metadata, the thread's items and its container, and
 *   hears a registry reload once wherever it is — and not at all once removed.
 * - A conversation tab moved or put back keeps its conversation's session and
 *   status feeds, which it takes when handed the conversation rather than on
 *   connect.
 * - The settings panel put back after a removal hears the socket again — its
 *   tabs are built once, with the panel, and give up their subscriptions on
 *   every disconnect — and still shows what it had drawn.
 * - A model selector moved or put back follows the provider list and the
 *   connection status exactly once.
 * - A properties panel follows the thread it was last handed — a reused column
 *   is handed a different one — and keeps that thread, its strategy feed and
 *   what it had drawn across a move or a put-back.
 * - A workspace panel moved or put back follows its session exactly once.
 * @module unit-tests/component-teardown
 */

import wsService from '../../js/services/websocket.js';
import connectionStatus from '../../js/services/connection-status.js';
import { REGISTRIES_RELOADED } from '../../js/registries/reload-registries.js';
import '../../js/components/tool-action-message.js';
import '../../js/components/path-input.js';
import '../../js/components/permission-controls.js';
import '../../js/components/strategy-selector.js';
import '../../js/components/conversation-tab.js';
import '../../js/components/settings-panel.js';
import '../../js/components/model-selector.js';
import '../../js/components/properties-panel.js';
import '../../js/components/workspace-panel.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * A Y.Array stand-in that counts its deep observers.
 * @returns {{observeDeep: (fn: Function) => void, unobserveDeep: (fn: Function) => void, toArray: () => any[], observers: Set<Function>}} The stand-in, with its live observer set.
 */
function countingYArray() {
  const observers = new Set();
  return {
    observers,
    observeDeep: (fn) => { observers.add(fn); },
    unobserveDeep: (fn) => { observers.delete(fn); },
    toArray: () => [],
  };
}

/**
 * A tool-action tile whose column lookup answers as the real one does: through
 * `closest`, so only while the tile is inside its column.
 * @param {ReturnType<typeof countingYArray>} yarray
 * @returns {any} The tile, not yet connected.
 */
function tileFor(yarray) {
  const tile = /** @type {any} */ (document.createElement('tool-action-message'));
  tile.setAttribute('message-id', 'ta-1');
  const thread = { yarray, items: [] };
  tile._getConversation = function () { return this.closest('.teardown-column') ? {} : null; };
  tile._getMessageThread = function () { return this.closest('.teardown-column') ? thread : null; };
  tile.render = () => {};
  return tile;
}

/**
 * A completion response the test releases when it chooses.
 * @returns {{restore: () => void, release: (paths: string[]) => void}} Controls to answer the held request and to put fetch back.
 */
function heldCompletions() {
  const originalFetch = window.fetch;
  /** @type {(r: Response) => void} */
  let resolve = () => {};
  window.fetch = /** @type {any} */ (() => new Promise((r) => { resolve = r; }));
  return {
    restore: () => { window.fetch = originalFetch; },
    release: (paths) => resolve(new window.Response(JSON.stringify({ results: paths.map((path) => ({ path })) }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })),
  };
}

/**
 * A message thread stand-in that counts metadata observers and session
 * subscribers.
 * @returns {any} The stand-in, with its live observer and subscriber sets.
 */
function countingThread() {
  const metadata = new Set();
  const session = new Set();
  return {
    metadata,
    session,
    strategy: null,
    conversation: {
      observeMetadata: (fn) => { metadata.add(fn); },
      unobserveMetadata: (fn) => { metadata.delete(fn); },
      session: {
        subscribe: (fn) => { session.add(fn); return () => session.delete(fn); },
      },
    },
  };
}

/**
 * How many listeners the socket holds for each of `events`.
 * @param {string[]} events
 * @returns {Record<string, number>} Listener count per event.
 */
function socketListeners(events) {
  const listeners = /** @type {any} */ (wsService)._listeners;
  return Object.fromEntries(events.map((e) => [e, listeners[e].length]));
}

/**
 * Each event's listener count above `baseline`, as one readable line.
 * @param {string[]} events
 * @param {Record<string, number>} baseline
 * @returns {string} e.g. "providers-update +1, clients-changed +0".
 */
function socketDelta(events, baseline) {
  const now = socketListeners(events);
  return events.map((e) => `${e} ${now[e] - baseline[e] >= 0 ? '+' : ''}${now[e] - baseline[e]}`).join(', ');
}

/**
 * @returns {Promise<TestResult>} Pass/fail counts and error messages.
 */
export async function runTests() {
  let passed = 0, failed = 0;
  /** @type {string[]} */
  const errors = [];
  const column = document.createElement('div');
  column.className = 'teardown-column';
  document.body.appendChild(column);

  try {
    const yarray = countingYArray();
    const tile = tileFor(yarray);
    column.appendChild(tile);
    if (yarray.observers.size !== 1) throw new Error(`a mounted tile observes ${yarray.observers.size} times, want 1`);
    tile.remove();
    if (yarray.observers.size !== 0) {
      throw new Error(`a tile removed on its own still observes the thread (${yarray.observers.size} observer(s))`);
    }
    passed++;
  } catch (e) { failed++; errors.push(`tool-action tile removed alone: ${e.message}`); }

  try {
    const yarray = countingYArray();
    const tile = tileFor(yarray);
    column.appendChild(tile);
    const other = document.createElement('div');
    other.className = 'teardown-column';
    document.body.appendChild(other);
    other.appendChild(tile);
    other.remove();
    if (yarray.observers.size !== 0) throw new Error(`${yarray.observers.size} observer(s) left after a move and a removal`);
    passed++;
  } catch (e) { failed++; errors.push(`tool-action tile moved then removed: ${e.message}`); }

  for (const [label, end] of /** @type {Array<[string, (el: any) => void]>} */ ([
    ['removed', (el) => el.remove()],
    ['closed', (el) => el._closeMenu()],
  ])) {
    const held = heldCompletions();
    const el = /** @type {any} */ (document.createElement('path-input'));
    try {
      document.body.appendChild(el);
      const fetching = el._fetch('/');
      end(el);
      held.release(['/tmp/']);
      await fetching;
      const orphan = document.body.querySelector('.path-input-menu');
      if (orphan) {
        orphan.remove();
        throw new Error('a completion arriving after the field was ' + label + ' opened a menu on <body>');
      }
      passed++;
    } catch (e) { failed++; errors.push(`path-input fetch outliving a field ${label}: ${e.message}`); }
    finally {
      el._closeMenu?.();
      el.remove();
      held.restore();
    }
  }

  try {
    const thread = countingThread();
    const control = /** @type {any} */ (document.createElement('permission-controls'));
    control.render = () => {};
    control._renderButton = () => {};
    column.appendChild(control);
    control.setMessageThread(thread);
    const elsewhere = document.createElement('div');
    document.body.appendChild(elsewhere);
    elsewhere.appendChild(control);
    try {
      if (thread.metadata.size !== 1 || thread.session.size !== 1) {
        throw new Error(`after a move it holds ${thread.metadata.size} metadata observer(s) and ${thread.session.size} session subscription(s), want 1 and 1`);
      }
      control.remove();
      if (thread.metadata.size !== 0 || thread.session.size !== 0) {
        throw new Error(`after removal it holds ${thread.metadata.size} metadata observer(s) and ${thread.session.size} session subscription(s), want none`);
      }
      passed++;
    } finally {
      elsewhere.remove();
    }
  } catch (e) { failed++; errors.push(`permission-controls re-parented: ${e.message}`); }

  try {
    const thread = countingThread();
    const yarray = countingYArray();
    const containerObservers = new Set();
    Object.assign(thread, {
      yarray,
      threadItemId: 'teardown-thread',
      currentStrategyId: 'default',
      container: {
        observe: (/** @type {Function} */ fn) => { containerObservers.add(fn); },
        unobserve: (/** @type {Function} */ fn) => { containerObservers.delete(fn); },
      },
    });
    const selector = /** @type {any} */ (document.createElement('strategy-selector'));
    let rebaselines = 0;
    selector.render = () => {};
    selector._refreshCacheInputs = async (/** @type {{rebaseline?: boolean}} */ opts) => {
      if (opts?.rebaseline) rebaselines++;
    };
    selector._recomputeImpact = () => {};
    let reloads = 0;
    selector.loadStrategies = () => { reloads++; };
    const heardReload = () => {
      const before = reloads;
      document.dispatchEvent(new CustomEvent(REGISTRIES_RELOADED));
      return reloads - before;
    };
    column.appendChild(selector);
    selector.setMessageThread(thread);
    const settle = () => new Promise((r) => queueMicrotask(() => r(undefined)));
    const elsewhere = document.createElement('div');
    document.body.appendChild(elsewhere);
    try {
      const held = () => `${thread.metadata.size} metadata, ${yarray.observers.size} items and ${containerObservers.size} container observer(s)`;
      const holdsOneOfEach = () => thread.metadata.size === 1 && yarray.observers.size === 1 && containerObservers.size === 1;
      const bound = rebaselines;
      elsewhere.appendChild(selector);
      await settle();
      if (!holdsOneOfEach()) throw new Error(`after a move it holds ${held()}, want 1 of each`);
      // A rebaseline captures the staged strategy as already cached, clearing a
      // cache-bust caution the user has not acted on yet.
      if (rebaselines !== bound) throw new Error(`a move rebaselined the cache-bust caution ${rebaselines - bound} time(s)`);
      let heard = heardReload();
      if (heard !== 1) throw new Error(`after a move a registry reload reached it ${heard} time(s), want 1`);
      selector.remove();
      await settle();
      if (thread.metadata.size !== 0 || yarray.observers.size !== 0 || containerObservers.size !== 0) {
        throw new Error(`after removal it holds ${held()}, want none`);
      }
      heard = heardReload();
      if (heard !== 0) throw new Error(`after removal a registry reload reached it ${heard} time(s), want none`);
      elsewhere.appendChild(selector);
      if (!holdsOneOfEach()) throw new Error(`reinserted after a removal it holds ${held()}, want 1 of each`);
      heard = heardReload();
      if (heard !== 1) throw new Error(`reinserted after a removal a registry reload reached it ${heard} time(s), want 1`);
      selector.remove();
      await settle();
      passed++;
    } finally {
      elsewhere.remove();
    }
  } catch (e) { failed++; errors.push(`strategy-selector re-parented: ${e.message}`); }

  try {
    const session = new Set();
    const status = new Set();
    const conversation = {
      id: 'teardown-conv',
      rootItems: [],
      llmState: null,
      setTabElement: () => {},
      onStatusChange: (/** @type {Function} */ fn) => { status.add(fn); return () => status.delete(fn); },
      session: { subscribe: (/** @type {Function} */ fn) => { session.add(fn); return () => session.delete(fn); } },
    };
    const tab = /** @type {any} */ (document.createElement('conversation-tab'));
    column.appendChild(tab);
    tab.setConversation(conversation);
    const elsewhere = document.createElement('div');
    document.body.appendChild(elsewhere);
    try {
      const held = () => `${session.size} session and ${status.size} status subscription(s)`;
      elsewhere.appendChild(tab);
      if (session.size !== 1 || status.size !== 1) throw new Error(`after a move it holds ${held()}, want 1 and 1`);
      tab.remove();
      if (session.size !== 0 || status.size !== 0) throw new Error(`after removal it holds ${held()}, want none`);
      elsewhere.appendChild(tab);
      if (session.size !== 1 || status.size !== 1) throw new Error(`reinserted after a removal it holds ${held()}, want 1 and 1`);
      tab.remove();
      passed++;
    } finally {
      elsewhere.remove();
    }
  } catch (e) { failed++; errors.push(`conversation-tab re-parented: ${e.message}`); }

  try {
    const events = ['providers-update', 'clients-changed', 'plugin-changed'];
    const baseline = socketListeners(events);
    const panel = /** @type {any} */ (document.createElement('settings-panel'));
    const elsewhere = document.createElement('div');
    document.body.appendChild(elsewhere);
    try {
      const holdsOneOfEach = () => socketDelta(events, baseline) === events.map((e) => `${e} +1`).join(', ');
      column.appendChild(panel);
      if (!holdsOneOfEach()) throw new Error(`a mounted panel holds ${socketDelta(events, baseline)}, want +1 of each`);
      const drawn = document.createElement('span');
      drawn.className = 'teardown-drawn';
      panel.querySelector('#provider-fields-container').appendChild(drawn);
      elsewhere.appendChild(panel);
      if (!holdsOneOfEach()) throw new Error(`after a move it holds ${socketDelta(events, baseline)}, want +1 of each`);
      panel.remove();
      if (socketDelta(events, baseline) !== events.map((e) => `${e} +0`).join(', ')) {
        throw new Error(`after removal it holds ${socketDelta(events, baseline)}, want none`);
      }
      elsewhere.appendChild(panel);
      if (!holdsOneOfEach()) throw new Error(`reinserted after a removal it holds ${socketDelta(events, baseline)}, want +1 of each`);
      // Nothing redraws a tab's fields after the first config load, so a reinsert
      // that re-rendered the shell would leave them empty for good.
      if (!panel.querySelector('.teardown-drawn')) throw new Error('reinserting the panel threw away the fields it had drawn');
      panel.remove();
      passed++;
    } finally {
      panel.remove();
      elsewhere.remove();
    }
  } catch (e) { failed++; errors.push(`settings-panel re-parented: ${e.message}`); }

  {
    const realSubscribe = connectionStatus.subscribe;
    let statusSubscribers = 0;
    connectionStatus.subscribe = (fn) => {
      statusSubscribers++;
      const off = realSubscribe.call(connectionStatus, fn);
      return () => { statusSubscribers--; off(); };
    };
    const baseline = socketListeners(['providers-update']);
    const selector = /** @type {any} */ (document.createElement('model-selector'));
    selector.fetchProviders = async () => {};
    const elsewhere = document.createElement('div');
    document.body.appendChild(elsewhere);
    try {
      const held = () => `${socketDelta(['providers-update'], baseline)} and ${statusSubscribers} status subscription(s)`;
      const holdsOne = () => held() === 'providers-update +1 and 1 status subscription(s)';
      column.appendChild(selector);
      elsewhere.appendChild(selector);
      if (!holdsOne()) throw new Error(`after a move it holds ${held()}, want +1 and 1`);
      selector.remove();
      if (held() !== 'providers-update +0 and 0 status subscription(s)') throw new Error(`after removal it holds ${held()}, want none`);
      elsewhere.appendChild(selector);
      if (!holdsOne()) throw new Error(`reinserted after a removal it holds ${held()}, want +1 and 1`);
      selector.remove();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`model-selector re-parented: ${e.message}`);
    } finally {
      selector.remove();
      elsewhere.remove();
      connectionStatus.subscribe = realSubscribe;
    }
  }

  try {
    const session = new Set();
    const threadFor = () => ({
      container: countingYArray(),
      items: [],
      pendingItems: [],
      getContextItem: () => null,
      conversation: { session: { subscribe: (/** @type {Function} */ fn) => { session.add(fn); return () => session.delete(fn); } } },
    });
    const first = threadFor();
    const second = threadFor();
    const panel = /** @type {any} */ (document.createElement('properties-panel'));
    column.appendChild(panel);
    panel.setConversation({ id: 'teardown-conv' });
    panel.setMessageThread(first);
    const elsewhere = document.createElement('div');
    document.body.appendChild(elsewhere);
    try {
      const held = () => `${first.container.observers.size} on the first thread, ${second.container.observers.size} on the second and ${session.size} session subscription(s)`;
      const onSecond = () => first.container.observers.size === 0 && second.container.observers.size === 1 && session.size === 1;
      // The column builder hands a reused column the thread to its left, which
      // changes when a different thread is opened beside it.
      panel.setMessageThread(second);
      if (!onSecond()) throw new Error(`handed another thread it holds ${held()}, want 0, 1 and 1`);
      // The column builder draws a panel only when its selection changes, so a
      // move that threw the drawing away would leave it blank.
      const drawn = document.createElement('span');
      drawn.className = 'teardown-drawn';
      panel.querySelector('properties-panel-content').appendChild(drawn);
      elsewhere.appendChild(panel);
      if (!onSecond()) throw new Error(`after a move it holds ${held()}, want 0, 1 and 1`);
      if (!panel.querySelector('.teardown-drawn')) throw new Error('a move threw away what the panel had drawn');
      panel.remove();
      if (second.container.observers.size !== 0 || session.size !== 0) throw new Error(`after removal it holds ${held()}, want none`);
      elsewhere.appendChild(panel);
      if (!onSecond()) throw new Error(`reinserted after a removal it holds ${held()}, want 0, 1 and 1`);
      panel.remove();
      passed++;
    } finally {
      panel.remove();
      elsewhere.remove();
    }
  } catch (e) { failed++; errors.push(`properties-panel rebound and re-parented: ${e.message}`); }

  try {
    const subscribers = new Set();
    const session = { subscribe: (/** @type {Function} */ fn) => { subscribers.add(fn); return () => subscribers.delete(fn); } };
    const panel = /** @type {any} */ (document.createElement('workspace-panel'));
    column.appendChild(panel);
    panel.setSession(session);
    const elsewhere = document.createElement('div');
    document.body.appendChild(elsewhere);
    try {
      elsewhere.appendChild(panel);
      if (subscribers.size !== 1) throw new Error(`after a move it holds ${subscribers.size} session subscription(s), want 1`);
      panel.remove();
      if (subscribers.size !== 0) throw new Error(`after removal it holds ${subscribers.size} session subscription(s), want none`);
      elsewhere.appendChild(panel);
      if (subscribers.size !== 1) throw new Error(`reinserted after a removal it holds ${subscribers.size} session subscription(s), want 1`);
      panel.setSession(session);
      if (subscribers.size !== 1) throw new Error(`handed its session again it holds ${subscribers.size} session subscription(s), want 1`);
      panel.remove();
      passed++;
    } finally {
      panel.remove();
      elsewhere.remove();
      document.body.classList.remove('workspace-selected');
    }
  } catch (e) { failed++; errors.push(`workspace-panel re-parented: ${e.message}`); }

  column.remove();
  return { passed, failed, errors };
}
