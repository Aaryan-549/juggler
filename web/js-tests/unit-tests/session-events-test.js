//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The session's event feed: `session.events`, and the `session.subscribe`
 * door extensions listen through.
 *
 * - `session.subscribe` lands on `session.events`, read at call time, so a
 *   feed swapped onto the session is the one subscribed to.
 * - Each event carries its type, its data and the session it happened on.
 * - Each subscription is its own: one callback subscribed twice is called
 *   twice, and either unsubscribe releases only its own.
 * - The fan-out walks the live set: a subscription taken during it hears the
 *   event, and one released before it is reached does not.
 * - `destroy()` releases every subscription.
 *
 * That a throwing subscriber is contained and reported is held by
 * `unit:ws-listener-isolation`, beside the socket's own case.
 *
 * Runs against a bare Session — no server, no workers.
 * @module unit-tests/session-events-test
 */

import { assert, trackTestSession } from '../utilities/test-helpers.js';
import Session from '../../js/model/session.js';
import SessionEvents from '../../js/model/session-events.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * A bare session, under the suite-end sweep.
 * @returns {any} The session
 */
function bareSession() {
  return trackTestSession(new Session(/** @type {any} */ ({})));
}

/**
 * Run all session-events tests.
 * @param {unknown} _ctx - Unused test context
 * @returns {Promise<TestResult>} Aggregated test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label
   * @param {() => void} fn
   */
  const run = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  await run('session.subscribe hears what session.events announces, with the session on it', () => {
    const session = bareSession();
    assert(session.events instanceof SessionEvents, 'session.events is missing — there is no feed to announce on');
    /** @type {any[]} */
    const heard = [];
    const off = session.subscribe((/** @type {any} */ event) => { heard.push(event); });
    session.events.notify('conversation:renamed', { conversationId: 'c1' });
    off();
    assert(heard.length === 1, `the subscriber heard ${heard.length} event(s), want 1`);
    assert(heard[0].type === 'conversation:renamed', `the event's type is ${heard[0].type}`);
    assert(heard[0].data?.conversationId === 'c1', 'the event lost its data');
    assert(heard[0].session === session, 'the event does not carry the session it happened on');
  });

  await run('session.subscribe reads the feed at call time', () => {
    const session = bareSession();
    /** @type {any[]} */
    const taken = [];
    // A whole feed, because the suite-end sweep destroys this session and
    // destroy() clears whatever feed it holds.
    session.events = {
      subscribe: (/** @type {any} */ cb) => { taken.push(cb); return () => {}; },
      notify: () => {},
      clear: () => {}
    };
    const callback = () => {};
    session.subscribe(callback);
    assert(taken.length === 1 && taken[0] === callback,
      'a feed swapped onto the session was not the one subscribed to');
  });

  await run('each subscription is its own, so unsubscribing one leaves a twin running', () => {
    const session = bareSession();
    let calls = 0;
    const callback = () => { calls++; };
    const offFirst = session.subscribe(callback);
    const offSecond = session.subscribe(callback);
    session.events.notify('session:saved', null);
    assert(calls === 2, `one callback subscribed twice was called ${calls} time(s), want 2`);
    offFirst();
    offFirst();
    session.events.notify('session:saved', null);
    assert(calls === 3, `after one unsubscribe (called twice) the twin should still hear, calls=${calls}`);
    offSecond();
    session.events.notify('session:saved', null);
    assert(calls === 3, `after both unsubscribes nothing should hear, calls=${calls}`);
  });

  await run('the fan-out walks the live set', () => {
    const session = bareSession();
    /** @type {string[]} */
    const order = [];
    /** @type {() => void} */
    let offThird = () => {};
    let joined = false;
    session.subscribe(() => {
      order.push('first');
      offThird();
      if (!joined) {
        joined = true;
        session.subscribe(() => { order.push('late'); });
      }
    });
    session.subscribe(() => { order.push('second'); });
    offThird = session.subscribe(() => { order.push('third'); });
    session.events.notify('session:loaded', null);
    assert(order.join(',') === 'first,second,late',
      `want first,second,late — the released third skipped, the late joiner heard — got ${order.join(',')}`);
  });

  await run('destroy releases every subscription', () => {
    const session = bareSession();
    const events = session.events;
    let calls = 0;
    session.subscribe(() => { calls++; });
    session.subscribe(() => { calls++; });
    session.destroy();
    events.notify('session:loaded', null);
    assert(calls === 0, `a destroyed session's subscribers heard ${calls} event(s)`);
  });

  return { passed, failed, errors };
}
