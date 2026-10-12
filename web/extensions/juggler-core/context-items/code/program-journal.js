//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The journal a run_code program replays from.
 *
 * A program that stops to wait for an approval is run again from the top once
 * it is given, so everything it did before the stop must not happen twice.
 * The journal records every call the program makes through its capabilities
 * (`fs`, `grep`, `glob`, `tools`, and the read behind `image(path)`), in the
 * order the program makes them, with what each gave back. On a replay, each
 * call is matched against the record at its step and answered from it without
 * calling through; past the end of the record, or at a step left unsettled
 * when the last pass ended, calls go through and are recorded in turn.
 *
 * The replay stands in for the program's state having been kept and restored:
 * it is how a program picks up where it stopped, not a second run. So a
 * replayed call answers with what it answered then, however the world has
 * changed since — the program goes on from the state it was in. What it does
 * next meets the world as it is now: a held edit whose file has changed since
 * the program read it is refused by the edit tool's own staleness check, which
 * the read credit a replay restores is there to feed.
 *
 * Capabilities are the program's only way to see or touch anything, so a
 * program that makes the same calls sees the same answers. One whose call at
 * some step differs from the record — another capability, other arguments —
 * has diverged: it would act on answers it never saw, so the call is refused
 * and `onDiverge` is told, which ends the program. Nothing else needs to be
 * deterministic: `Date.now` or `Math.random` matter only when they change a
 * call, and then they diverge.
 *
 * Steps are taken in the order calls are made, and calls made concurrently
 * are made in the order the answers before them arrived: under `Promise.all`,
 * the read that answers first is the one whose follow-up call comes next. So
 * a replay gives its answers in the order the pass that recorded them got
 * them (each entry's `seq`), each once it has been asked for and every answer
 * before it has been given. Every call that goes through on a replay waits
 * for the recorded answers to have all been given before it answers: none of
 * them had answered when the recorded pass ended. A program that never asks
 * for an answer it asked for before leaves the rest waiting; `stalledOn`
 * names the call it never made.
 *
 * Answers due together are given together, so the order holds only because
 * the sandbox hands each to the program as a message of its own: the program
 * has made every call the first leads to before it sees the second. A program
 * given two answers in one microtask burst would act on whichever its code
 * reaches sooner, and take its steps out of order.
 *
 * A refusal or a cancel is not an answer, so neither is recorded: a replay
 * makes that call again, and asks again.
 *
 * The call a program was suspended on is recorded as held: it has no answer
 * yet, but it is the call the user was asked about. A replay that reaches its
 * step checks it like any other, tells `onHeld`, and calls through, so the
 * caller can hand it over as answered; what it then gives back replaces the
 * held entry.
 *
 * Pure — capabilities in, wrapped capabilities out; the journal is the
 * caller's to keep between passes.
 * @module context-items/code/program-journal
 */

import { extractErrorMessage } from '../../../../sdk/lib/error-utils.js';

/** A replayed call differed from the record at its step. */
export class ProgramDiverged extends Error {
  /** @param {string} message - Which step, and how it differed */
  constructor(message) {
    super(message);
    this.name = 'ProgramDiverged';
  }
}

/**
 * @typedef {object} JournalEntry
 * @property {string} key - The capability called: `fs.readFile`, `grep`, `tools.edit`
 * @property {string} args - Its arguments, as JSON
 * @property {boolean} ok - Whether it answered or threw
 * @property {boolean} [held] - The program was suspended on it: no answer yet
 * @property {unknown} [value] - What it answered
 * @property {string} [error] - What it threw
 * @property {string} [errorName] - The thrown error's name
 * @property {Array<[string, string|null]>} [reads] - Read credit it earned, path → hash
 * @property {number} [seq] - Where its answer came in the order the program got answers
 */

/** Errors that are not a call's answer, and so are never recorded. */
const UNRECORDED = new Set(['ToolRefused', 'AbortError']);

/** Longest stretch of a call's arguments quoted in a divergence. */
const MAX_QUOTED = 120;

/**
 * Arguments as the journal compares them.
 * @param {unknown[]} args - A call's arguments
 * @returns {string} Their JSON, or a marker for what JSON cannot hold
 */
function argsKey(args) {
  try {
    return JSON.stringify(args) ?? '';
  } catch {
    return '[unserialisable]';
  }
}

/**
 * One call, as a divergence names it.
 * @param {string} key - The capability
 * @param {string} args - Its arguments, as JSON
 * @returns {string} e.g. `tools.bash({"command":"ls"})`
 */
function describeCall(key, args) {
  const inner = args.startsWith('[') && args.endsWith(']') ? args.slice(1, -1) : args;
  return `${key}(${inner.length > MAX_QUOTED ? inner.slice(0, MAX_QUOTED) + '…' : inner})`;
}

/**
 * Wrap a program's capabilities so every call is recorded in, or answered
 * from, `journal`.
 * @param {Record<string, any>} capabilities - Functions (`grep`) and namespaces (`fs`, `tools`)
 * @param {object} opts
 * @param {Array<JournalEntry|undefined>} opts.journal - The record, kept between passes; mutated
 * @param {Map<string, string|null>} [opts.ledger] - Read credit the program's reads earn, path → hash; a replayed call restores what it earned
 * @param {(err: ProgramDiverged) => void} opts.onDiverge - Told when a call diverges
 * @param {(entry: JournalEntry) => void} [opts.onHeld] - Told, synchronously
 *   before it calls through, when a replay makes the call it was suspended on
 * @returns {Record<string, any>} The wrapped capabilities, by the same names,
 *   and — not enumerable, so it is never handed to the program among them —
 *   `stalledOn()`: the call a replay is waiting for the program to make again
 *   before it can give any more answers, as a divergence names it, or null
 */
export function journalCapabilities(capabilities, opts) {
  const { journal, ledger, onDiverge, onHeld } = opts;
  let step = 0;

  // The recorded answers, in the order the program got them. An entry with no
  // `seq` keeps no order and answers as soon as it is asked for.
  const order = /** @type {JournalEntry[]} */ (journal.filter((e) => e && !e.held && typeof e.seq === 'number'))
    .sort((a, b) => /** @type {number} */ (a.seq) - /** @type {number} */ (b.seq));
  let nextSeq = (order.at(-1)?.seq ?? -1) + 1;
  let given = 0;
  /**
   * Recorded calls asked for again, each waiting its turn to answer.
   * @type {Map<JournalEntry, () => void>}
   */
  const asked = new Map();
  /** Calls gone through on this replay, waiting for the recorded answers to be given. */
  let throughWaiting = 0;
  /** @type {(() => void)|null} */
  let allGiven = null;
  /** @type {Promise<void>} */
  const replayed = order.length === 0 ? Promise.resolve() : new Promise((resolve) => { allGiven = resolve; });

  /** Give every answer whose turn has come. */
  const give = () => {
    while (given < order.length) {
      const entry = /** @type {JournalEntry} */ (order[given]);
      const answer = asked.get(entry);
      if (!answer) return;
      asked.delete(entry);
      given++;
      answer();
    }
    allGiven?.();
  };

  /**
   * Wait until a recorded call's answer is due.
   * @param {JournalEntry} entry - The recorded call
   * @returns {Promise<void>} Resolves at its turn
   */
  const turnOf = (entry) => new Promise((resolve) => {
    asked.set(entry, resolve);
    // Given only once its caller is awaiting it: given here, at once, its
    // answer would come after those of calls already waiting, out of turn.
    queueMicrotask(give);
  });

  /**
   * Wait, for a call that went through, until every recorded answer is given.
   * @returns {Promise<void>} Resolves once they are
   */
  const afterReplay = async () => {
    throughWaiting++;
    try {
      await replayed;
    } finally {
      throughWaiting--;
    }
  };

  /**
   * @returns {string|null} The recorded call the replay waits on and the
   *   program has not made, while anything waits on it
   */
  const stalledOn = () => {
    const next = order[given];
    if (!next || asked.has(next) || (asked.size === 0 && throughWaiting === 0)) return null;
    return describeCall(next.key, next.args);
  };

  /**
   * One capability, journalled.
   * @param {string} key - Its name, as recorded
   * @param {(...args: unknown[]) => unknown} call - Calls through
   * @returns {(...args: unknown[]) => Promise<unknown>} The journalled call
   */
  const journalled = (key, call) => async (...args) => {
    const at = step++;
    const json = argsKey(args);
    const prior = journal[at];
    if (prior) {
      if (prior.key !== key || prior.args !== json) {
        const err = new ProgramDiverged(`Couldn't resume the program: at step ${at + 1} it called `
          + `${describeCall(key, json)}, but last time it called ${describeCall(prior.key, prior.args)}. `
          + 'Nothing from that step on ran.');
        onDiverge(err);
        throw err;
      }
      if (prior.held) {
        onHeld?.(prior);
      } else {
        if (typeof prior.seq === 'number') await turnOf(prior);
        for (const [p, hash] of prior.reads ?? []) ledger?.set(p, hash);
        if (prior.ok) return prior.value;
        const err = new Error(prior.error);
        if (prior.errorName) err.name = prior.errorName;
        throw err;
      }
    }
    const before = ledger ? new Map(ledger) : null;
    /**
     * The read credit this call earned.
     * @returns {Array<[string, string|null]>|undefined} New or changed entries
     */
    const earned = () => {
      if (!ledger || !before) return undefined;
      const reads = /** @type {Array<[string, string|null]>} */ ([...ledger].filter(([p, h]) => before.get(p) !== h));
      return reads.length > 0 ? reads : undefined;
    };
    /** @type {unknown} */
    let value;
    try {
      value = await call(...args);
    } catch (err) {
      const e = /** @type {Error} */ (err);
      if (e?.name === 'ToolSuspended') {
        journal[at] = { key, args: json, ok: false, held: true };
      } else if (!UNRECORDED.has(e?.name)) {
        const reads = earned();
        await afterReplay();
        journal[at] = { key, args: json, ok: false, error: extractErrorMessage(err), errorName: e?.name, reads, seq: nextSeq++ };
      }
      throw err;
    }
    const reads = earned();
    await afterReplay();
    journal[at] = { key, args: json, ok: true, value, reads, seq: nextSeq++ };
    return value;
  };

  /** @type {Record<string, any>} */
  const wrapped = {};
  for (const [name, cap] of Object.entries(capabilities)) {
    if (typeof cap === 'function') {
      wrapped[name] = journalled(name, cap);
    } else if (cap && typeof cap === 'object') {
      /** @type {Map<string, (...args: unknown[]) => Promise<unknown>>} */
      const methods = new Map();
      wrapped[name] = new Proxy({}, {
        get: (_target, method) => {
          if (typeof method !== 'string' || method === 'then') return undefined;
          let fn = methods.get(method);
          if (!fn) {
            fn = journalled(`${name}.${method}`, (...args) => cap[method](...args));
            methods.set(method, fn);
          }
          return fn;
        },
      });
    } else {
      wrapped[name] = cap;
    }
  }
  Object.defineProperty(wrapped, 'stalledOn', { value: stalledOn, enumerable: false });
  return wrapped;
}
