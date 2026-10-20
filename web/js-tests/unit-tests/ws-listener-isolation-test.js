//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * WebSocket listener isolation tests.
 *
 * Every inbound server message fans out to the subscribers of one event, and
 * those subscribers are independent of each other — the session model, the
 * pinboard, the provider list, the settings panel. One of them throwing must
 * cost that one subscriber its update and nothing else: the subscribers behind
 * it still hear the message, the throw does not escape into the transport's
 * receive path, and the fault reaches the app log through the fault sink,
 * because a release viewer has no console to read it in.
 *
 * Driven on a private `WebSocketService` instance, so no real subscriber in the
 * page is handed a fabricated message. The session's feed is held to the same
 * reporting rule, on a session of its own.
 * @module unit-tests/ws-listener-isolation-test
 */

import { assert, trackTestSession } from '../utilities/test-helpers.js';
import { WebSocketService } from '../../js/services/websocket.js';
import Session from '../../js/model/session.js';
import { setFaultSink } from '../../js/utils/fault-report.js';

/**
 * Run the WebSocket listener isolation tests.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * Run one case with a fresh fault sink installed, handing it the faults sent.
   * @param {string} name - Case name, for the error list.
   * @param {(faults: any[]) => void|Promise<void>} fn - The case.
   * @returns {Promise<void>} Settles once the case has been scored.
   */
  const run = (name, fn) => {
    /** @type {any[]} */
    const faults = [];
    setFaultSink((/** @type {any} */ fault) => { faults.push(fault); });
    return Promise.resolve().then(() => fn(faults)).then(() => { passed++; }).catch((e) => {
      failed++;
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }).finally(() => { setFaultSink(null); });
  };

  // The inbound path end to end: a frame off the wire, parsed and routed to
  // 'message', with a broken subscriber ahead of a healthy one.
  await run('a throwing message listener does not starve the ones behind it', (/** @type {any} */ faults) => {
    const ws = new WebSocketService();
    /** @type {any[]} */
    const heard = [];
    ws.on('message', () => { throw new Error('subscriber blew up'); });
    ws.on('message', (/** @type {any} */ data) => { heard.push(data); });

    ws._handleMessageData(JSON.stringify({ conversationId: 'conv_x', workerMsgType: 'probe' }));

    assert(heard.length === 1,
      `the listener behind a throwing one must still hear the message, heard ${heard.length}`);
    assert(heard[0]?.conversationId === 'conv_x',
      `it must hear the message itself, got ${JSON.stringify(heard[0])}`);
    assert(faults.length === 1,
      `the throw must reach the fault sink once, got ${faults.length} — a release viewer has no console`);
    assert(faults[0].source === 'ws-listener:message',
      `the fault must name the event it was delivering, got ${faults[0].source}`);
    assert(faults[0].message === 'subscriber blew up',
      `the fault must carry what was thrown, got ${faults[0].message}`);
  });

  // A frame is told apart by its `type` and nothing else. One without a type is
  // a 'message' whatever its fields happen to be called — no key it carries
  // promotes it to an event of its own.
  await run('a frame without a type is a message, whatever fields it carries', () => {
    const typeless = [
      { error: 'x', message: 'y', conversationId: 'conv_x' },
      { retry: true, attempt: 1, maxRetries: 3, conversationId: 'conv_x' },
    ];
    for (const frame of typeless) {
      const ws = new WebSocketService();
      /** @type {string[]} */
      const emitted = [];
      const emit = ws._emit.bind(ws);
      ws._emit = (/** @type {any} */ event, /** @type {any} */ data) => { emitted.push(event); emit(event, data); };

      ws._handleMessageData(JSON.stringify(frame));

      assert(emitted.join() === 'message',
        `${JSON.stringify(frame)} must be delivered as 'message' and nothing else, emitted [${emitted.join(', ')}]`);
    }
  });

  // Every event rides the same fan-out, so the rule is the emitter's, not the
  // message route's: a connection event is held to it too.
  await run('a throwing listener does not escape the emitter', (/** @type {any} */ faults) => {
    const ws = new WebSocketService();
    let secondRan = 0;
    ws.on('providers-update', () => { throw new Error('first blew up'); });
    ws.on('providers-update', () => { secondRan++; });

    let escaped = null;
    try {
      ws._emit('providers-update', []);
    } catch (e) {
      escaped = e;
    }

    assert(escaped === null, `a listener's throw must not reach the emitter's caller, got ${escaped}`);
    assert(secondRan === 1, `the second listener should run once, ran ${secondRan} times`);
    assert(faults.length === 1 && faults[0].source === 'ws-listener:providers-update',
      `expected one fault named ws-listener:providers-update, got ${JSON.stringify(faults.map((/** @type {any} */ f) => f.source))}`);
  });

  // The session's own feed is the app's other bus, and its subscribers are just
  // as independent — so a throw there owes the app log the same report.
  await run('a throwing session subscriber is reported like a socket one', (/** @type {any} */ faults) => {
    const session = /** @type {any} */ (trackTestSession(new Session(/** @type {any} */ ({}))));
    let secondRan = 0;
    const offFirst = session.subscribe(() => { throw new Error('session subscriber blew up'); });
    const offSecond = session.subscribe(() => { secondRan++; });
    try {
      session.events.notify('listener-isolation:probe', null);
    } finally {
      offFirst();
      offSecond();
    }

    assert(secondRan === 1, `the subscriber behind a throwing one should run once, ran ${secondRan} times`);
    assert(faults.length === 1,
      `the throw must reach the fault sink once, got ${faults.length} — a release viewer has no console`);
    assert(faults[0].source === 'session-listener:listener-isolation:probe',
      `the fault must name the event it was delivering, got ${faults[0].source}`);
    assert(faults[0].message === 'session subscriber blew up',
      `the fault must carry what was thrown, got ${faults[0].message}`);
  });

  // The session is a subscriber too, and it must hand back everything it took:
  // a socket listener left behind outlives the session it closes over and runs
  // against it on every broadcast. Services can be set more than once, so the
  // second set replaces the first's subscriptions rather than adding to them.
  await run('the session gives back every socket subscription it took', () => {
    /** @type {Map<string, Set<Function>>} */
    const live = new Map();
    const ws = {
      on(/** @type {string} */ type, /** @type {Function} */ cb) {
        let set = live.get(type);
        if (!set) live.set(type, set = new Set());
        set.add(cb);
        return () => { live.get(type)?.delete(cb); };
      },
      off(/** @type {string} */ type, /** @type {Function} */ cb) { live.get(type)?.delete(cb); }
    };
    const held = () => [...live].filter(([, set]) => set.size > 0)
      .map(([type, set]) => `${type}×${set.size}`);
    const session = /** @type {any} */ (trackTestSession(new Session(/** @type {any} */ ({}))));

    session.setServices({ wsService: ws });
    const once = held();
    assert(once.length > 0, 'setServices subscribed to nothing, so this case proves nothing');
    assert(once.every((entry) => entry.endsWith('×1')), `one subscription per feed, got ${once.join(', ')}`);

    session.setServices({ wsService: ws });
    assert(held().join() === once.join(),
      `setting services again must replace the subscriptions, not add to them: ${once.join(', ')} then ${held().join(', ')}`);

    session.destroy();
    assert(held().length === 0, `destroy left socket subscriptions behind: ${held().join(', ')}`);
  });

  return { passed, failed, errors };
}
