//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The program journal (context-items/code/program-journal.js) against random
 * programs: trees of sequential and concurrent capability calls, each call's
 * arguments built from the answers before it, so a replay that hands any
 * answer to the wrong call changes what the program asks next.
 *
 * Nothing here depends on time. Every capability call waits in a pending set,
 * and a scheduler seeded with the case's number picks which one answers next,
 * once every microtask has run — so one seed is one interleaving, on any
 * machine, and a failure names the seed that reproduces it.
 *
 * The program sits behind a stand-in for the sandbox boundary: each answer
 * reaches it as a task of its own, through one port, as the sandbox iframe's
 * replies do. The journal's order rests on that: it may give two answers
 * together, and only the boundary lets the program act on the first before it
 * sees the second.
 *
 * Each case runs the program once uninterrupted, for reference. Then it runs
 * it in passes over one journal, as run_code does: a pass may stop on a tool
 * call that waits for the user, and the next replays it with that call
 * approved, until a pass finishes. A stopped pass is dead as a sandbox is: the
 * program makes no more calls, while calls already under way still answer and
 * a tool call under way is refused, as the invoker refuses it.
 *
 * Contract under test, for every case:
 *   1. No replay diverges or stalls: the same program makes the same calls.
 *   2. Every change (tools.write) happens exactly once across all passes.
 *   3. The last pass returns what the uninterrupted run returned.
 * @module unit-tests/program-journal-replay-test
 */

import { assert } from '../../../js-tests/utilities/test-helpers.js';
import { journalCapabilities } from '../context-items/code/program-journal.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/** Random programs tried. */
const CASES = 400;

/** Passes a case may take; the last never stops. */
const MAX_PASSES = 5;

/**
 * The capabilities a program calls, weighted towards tool calls: only a tool
 * call stops a pass.
 */
const CAPS = ['fs.readFile', 'fs.readFile', 'grep', 'tools.read', 'tools.read', 'tools.write', 'tools.write', 'tools.write'];

/**
 * A seeded generator (mulberry32).
 * @param {number} seed - The seed
 * @returns {() => number} Uniform in [0, 1)
 */
function rngOf(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A short, stable hash of a string.
 * @param {string} s - The string
 * @returns {string} Its hash, in hex
 */
function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

/**
 * @typedef {{kind: 'call', cap: string, id: number}|{kind: 'seq'|'all', children: Node[]}} Node
 */

/**
 * A random program.
 * @param {() => number} rng - The generator
 * @returns {Node} Its tree
 */
function generate(rng) {
  let ids = 0;
  /**
   * @param {number} depth - How deep this node is
   * @returns {Node} The node
   */
  const node = (depth) => {
    if (depth >= 4 || (depth > 0 && rng() < 0.3)) {
      return { kind: 'call', cap: /** @type {string} */ (CAPS[Math.floor(rng() * CAPS.length)]), id: ids++ };
    }
    const n = 1 + Math.floor(rng() * 3);
    return { kind: rng() < 0.5 ? 'seq' : 'all', children: Array.from({ length: n }, () => node(depth + 1)) };
  };
  return node(0);
}

/**
 * Run a program over capabilities. A call's arguments are built from the
 * answer before it, and an answer that is a NotFound error is caught and
 * becomes part of what follows, as a program's own try/catch would.
 * @param {Node} tree - The program
 * @param {Record<string, any>} c - The capabilities it calls
 * @returns {Promise<string>} What it returns
 */
function runProgram(tree, c) {
  /**
   * @param {Node} n - The node
   * @param {string} acc - The answer before it
   * @returns {Promise<string>} Its answer
   */
  const run = async (n, acc) => {
    if (n.kind === 'call') {
      const arg = n.cap + '#' + n.id + '@' + hash(acc);
      try {
        if (n.cap === 'fs.readFile') return String(await c.fs.readFile(arg));
        if (n.cap === 'grep') return String(await c.grep(arg));
        if (n.cap === 'tools.read') return String(await c.tools.read({ path: arg }));
        return String(await c.tools.write({ path: arg }));
      } catch (e) {
        if (/** @type {Error} */ (e)?.name !== 'NotFound') throw e;
        return 'missing:' + /** @type {Error} */ (e).message;
      }
    }
    if (n.kind === 'seq') {
      let a = acc;
      for (const child of n.children) a = await run(child, a);
      return a;
    }
    const answers = await Promise.all(n.children.map((child) => run(child, acc)));
    return hash(answers.join(','));
  };
  return run(tree, '');
}

/**
 * Yield until every microtask queued so far, and every one they queue, has run.
 * @returns {Promise<void>}
 */
function settleMicrotasks() {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(0);
  });
}

/**
 * An error with a name, as a capability throws one.
 * @param {string} name - Its name
 * @param {string} message - Its message
 * @returns {Error} The error
 */
function named(name, message) {
  const err = new Error(message);
  err.name = name;
  return err;
}

/**
 * The world one pass runs against: capabilities whose calls wait to be
 * answered by the scheduler, a write log shared across passes, and the
 * stop a waiting tool call causes.
 * @param {object} opts
 * @param {string[]} opts.writes - Every change made, across passes
 * @param {number} opts.stopAt - Stop on the nth tool call that reaches through (from 0); -1 never
 * @returns {{caps: Record<string, any>, pending: Array<() => void>, stopped: () => boolean, approveNext: () => void, gate: (c: Record<string, any>) => Record<string, any>, delivering: () => boolean, close: () => void}} The pass's world
 */
function worldOf({ writes, stopAt }) {
  /** @type {Array<() => void>} */
  const pending = [];
  /** Answers on their way to the program, in the order they were sent. */
  /** @type {Array<() => void>} */
  const inbox = [];
  const port = new MessageChannel();
  port.port1.onmessage = () => { /** @type {() => void} */ (inbox.shift())(); };
  /**
   * Send an answer across the boundary.
   * @param {() => void} hand - Hands it to the program
   */
  const deliver = (hand) => {
    inbox.push(hand);
    port.port2.postMessage(0);
  };
  let stopped = false;
  let approved = false;
  let toolCalls = 0;

  /**
   * One call: it waits its turn, then answers, or throws NotFound for some
   * arguments — the same for the same arguments on every pass.
   * @param {string} key - The capability
   * @param {string} arg - Its argument
   * @returns {Promise<string>} Its answer
   */
  const answer = (key, arg) => new Promise((resolve, reject) => {
    pending.push(() => {
      if (key !== 'tools.write' && parseInt(hash(arg), 16) % 5 === 0) reject(named('NotFound', 'no ' + arg));
      else resolve(key + ':' + hash(arg));
    });
  });

  /**
   * A tool call, refused once the pass has stopped, as the invoker refuses
   * every call still under way when the program stops.
   * @param {string} name - The tool
   * @param {{path: string}} args - Its arguments
   * @returns {Promise<string>} Its answer
   */
  const tool = (name, args) => {
    const isApproved = approved;
    approved = false;
    const suspends = !isApproved && toolCalls++ === stopAt;
    return new Promise((resolve, reject) => {
      pending.push(() => {
        if (stopped) {
          reject(named('ToolRefused', 'The program stopped to wait for you.'));
        } else if (suspends) {
          stopped = true;
          reject(named('ToolSuspended', name + ' is waiting for you'));
        } else {
          if (name === 'write') writes.push(args.path);
          resolve('tools.' + name + ':' + hash(args.path));
        }
      });
    });
  };

  const caps = {
    fs: { readFile: (/** @type {string} */ p) => answer('fs.readFile', p) },
    grep: (/** @type {string} */ p) => answer('grep', p),
    tools: {
      read: (/** @type {{path: string}} */ a) => tool('read', a),
      write: (/** @type {{path: string}} */ a) => tool('write', a),
    },
  };

  /**
   * The program's side of a stopped pass: a dead sandbox makes no more calls.
   * @param {Record<string, any>} c - The capabilities the program is given
   * @returns {Record<string, any>} The same, refusing every call once stopped
   */
  const gate = (c) => {
    /**
     * @param {(...args: any[]) => Promise<any>} fn - A capability
     * @returns {(...args: any[]) => Promise<any>} It, gated, answering across the boundary
     */
    const g = (fn) => (...args) => (stopped
      ? Promise.reject(named('AbortError', 'stopped'))
      : new Promise((resolve, reject) => {
        fn(...args).then((v) => deliver(() => resolve(v)), (e) => deliver(() => reject(e)));
      }));
    return {
      fs: { readFile: g((p) => c.fs.readFile(p)) },
      grep: g((p) => c.grep(p)),
      tools: { read: g((a) => c.tools.read(a)), write: g((a) => c.tools.write(a)) },
    };
  };

  return {
    caps, pending, stopped: () => stopped, approveNext: () => { approved = true; }, gate,
    delivering: () => inbox.length > 0,
    close: () => port.port1.close(),
  };
}

/**
 * Drive one pass: answer pending calls in the order the generator picks until
 * the program has ended and nothing is under way.
 * @param {Promise<unknown>} program - The running program
 * @param {Array<() => void>} pending - Calls waiting to answer
 * @param {() => number} rng - Picks which answers next
 * @param {() => boolean} delivering - Whether answers are still crossing the boundary
 * @param {() => string|null} [stalledOn] - The journal's report of a stall
 * @returns {Promise<{ok: boolean, value?: unknown, error?: Error, stall?: string}>} How it ended
 */
async function drive(program, pending, rng, delivering, stalledOn) {
  /** @type {{ok: boolean, value?: unknown, error?: Error}|null} */
  let outcome = null;
  program.then((value) => { outcome = { ok: true, value }; }, (error) => { outcome = { ok: false, error }; });
  for (;;) {
    await settleMicrotasks();
    if (delivering()) continue;
    if (pending.length === 0) {
      if (outcome) return outcome;
      return { ok: false, stall: stalledOn?.() ?? 'nothing pending, and the program has not ended' };
    }
    const [next] = pending.splice(Math.floor(rng() * pending.length), 1);
    /** @type {() => void} */ (next)();
  }
}

/**
 * Run all journal replay tests.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Pass/fail counts
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name
   * @param {() => Promise<void>} fn
   */
  const test = async (name, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(name + ': ' + (e instanceof Error ? e.message : String(e)));
    }
  };

  /**
   * One case: the reference run, then the passes.
   * @param {number} seed - The case
   * @returns {Promise<{passes: number, stops: number}>} How many passes it took and how many stopped
   */
  const runCase = async (seed) => {
    const rng = rngOf(seed);
    const tree = generate(rng);
    const where = 'seed ' + seed + ' (' + JSON.stringify(tree).slice(0, 300) + ')';

    /** @type {string[]} */
    const refWrites = [];
    const ref = worldOf({ writes: refWrites, stopAt: -1 });
    const expected = await drive(runProgram(tree, ref.gate(ref.caps)), ref.pending, rng, ref.delivering);
    ref.close();
    assert(expected.ok, where + ': the reference run must finish: ' + (expected.error?.message ?? expected.stall));

    /** @type {any[]} */
    const journal = [];
    /** @type {string[]} */
    const writes = [];
    let stops = 0;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const last = pass === MAX_PASSES - 1;
      const stopAt = !last && rng() < 0.8 ? Math.floor(rng() * 3) : -1;
      const world = worldOf({ writes, stopAt });
      /** @type {Error[]} */
      const diverged = [];
      const wrapped = journalCapabilities(world.caps, {
        journal,
        onDiverge: (e) => diverged.push(e),
        onHeld: () => world.approveNext(),
      });
      const result = await drive(runProgram(tree, world.gate(wrapped)), world.pending, rng, world.delivering, wrapped.stalledOn);
      world.close();
      assert(diverged.length === 0, where + ', pass ' + (pass + 1) + ': diverged: ' + diverged[0]?.message);
      assert(!result.stall, where + ', pass ' + (pass + 1) + ': stalled on ' + result.stall);
      if (world.stopped()) {
        stops++;
        continue;
      }
      assert(result.ok, where + ', pass ' + (pass + 1) + ': failed: ' + result.error?.message);
      assert(result.value === expected.value, where + ': returned ' + String(result.value) + ', uninterrupted ' + String(expected.value));
      const done = [...writes].sort();
      const want = [...refWrites].sort();
      assert(JSON.stringify(done) === JSON.stringify(want),
        where + ': each change once — made ' + JSON.stringify(done) + ', uninterrupted ' + JSON.stringify(want));
      return { passes: pass + 1, stops };
    }
    throw new Error(where + ': never finished in ' + MAX_PASSES + ' passes');
  };

  await test('random programs replay to the uninterrupted result, each change once', async () => {
    /** @type {string[]} */
    const failures = [];
    let stops = 0;
    let multi = 0;
    for (let seed = 1; seed <= CASES; seed++) {
      try {
        const r = await runCase(seed);
        stops += r.stops;
        if (r.stops > 1) multi++;
      } catch (e) {
        failures.push(e instanceof Error ? e.message : String(e));
      }
    }
    assert(failures.length === 0, failures.length + ' of ' + CASES + ' cases failed; first:\n' + failures.slice(0, 3).join('\n'));
    // Guard against a generator that stops making the cases worth having.
    assert(stops > CASES / 2 && multi > CASES / 10, 'too few stops to test replay: ' + stops + ' stops, ' + multi + ' cases with several');
  });

  return { passed, failed, errors };
}
