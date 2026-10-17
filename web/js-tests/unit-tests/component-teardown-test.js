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
 *   stays bound to across the move.
 * @module unit-tests/component-teardown
 */

import '../../js/components/tool-action-message.js';
import '../../js/components/path-input.js';
import '../../js/components/permission-controls.js';

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

  column.remove();
  return { passed, failed, errors };
}
