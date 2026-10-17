//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Where `<diff-viewer>` gets a snapshot diff computed: never inside the call
 * that asked for it, one job at a time, cancellable until it starts, and
 * remembered afterwards.
 *
 * The case this is shaped by is a reader holding ↑/↓ through a run of edits to
 * one big file. Each step mounts a viewer and the next one removes it, so a job
 * is queued rather than run, and a viewer that leaves before its job starts
 * cancels it: only the edit the reader stops on is ever computed. Jobs are
 * handed out one at a time so the queue stays here, where cancelling is free,
 * rather than in the worker, where a job already posted would run regardless.
 * A result is kept in a small cache keyed on the whole input, so stepping back
 * to an edit already seen draws at once.
 */

import { buildSnapshot } from './diff-snapshot.js';
import { extractErrorMessage } from '../../sdk/lib/error-utils.js';

/** @typedef {import('./diff-snapshot.js').SnapshotInput} SnapshotInput */
/** @typedef {import('./diff-snapshot.js').Snapshot} Snapshot */

/** How many computed snapshots are remembered. */
const CACHE_SIZE = 8;

/**
 * How many jobs have been started, and how many of those the diff worker
 * answered. Read by tests, which count work rather than time it.
 */
export const snapshotStats = { computed: 0, offThread: 0 };

/**
 * @typedef {object} Job
 * @property {SnapshotInput} input - What to compute.
 * @property {Set<(result: Snapshot) => void>} waiters - Who wants the answer.
 * @property {boolean} started - Whether it has been handed out.
 */

/** @type {{input: SnapshotInput, result: Snapshot}[]} Most recently used last. */
const cache = [];
/** @type {Job[]} */
const queue = [];
/** @type {Job|null} The job handed out and not yet answered. */
let running = null;

/**
 * Whether two inputs ask for the same snapshot. Lengths are compared before
 * content, so two different files almost never cost a string comparison.
 * @param {SnapshotInput} a - One input.
 * @param {SnapshotInput} b - The other.
 * @returns {boolean} True when they are the same request.
 */
function sameInput(a, b) {
  return a.oldContent.length === b.oldContent.length
    && a.newContent.length === b.newContent.length
    && a.startLineNumber === b.startLineNumber
    && a.contextLines === b.contextLines
    && a.filePath === b.filePath
    && a.oldContent === b.oldContent
    && a.newContent === b.newContent;
}

/**
 * The snapshot for this input, if it has already been computed.
 * @param {SnapshotInput} input - The request.
 * @returns {Snapshot|undefined} The remembered result.
 */
export function cachedSnapshot(input) {
  const at = cache.findIndex((entry) => sameInput(entry.input, input));
  if (at < 0) return undefined;
  const [entry] = cache.splice(at, 1);
  cache.push(/** @type {{input: SnapshotInput, result: Snapshot}} */ (entry));
  return entry?.result;
}

/**
 * @param {SnapshotInput} input - The request.
 * @param {Snapshot} result - Its answer.
 */
function remember(input, result) {
  const at = cache.findIndex((entry) => sameInput(entry.input, input));
  if (at >= 0) cache.splice(at, 1);
  cache.push({ input, result });
  while (cache.length > CACHE_SIZE) cache.shift();
}

/**
 * Compute one snapshot on the page, in a task of its own so the page paints and
 * takes input between jobs. The fallback for a page with no diff worker.
 * @param {SnapshotInput} input - The request.
 * @returns {Promise<Snapshot>} Its answer.
 */
const computeOnPage = (input) => new Promise((resolve) => {
  setTimeout(() => resolve(buildSnapshot(input)), 0);
});

/** @type {Worker|null} */
let worker = null;
/** Set once the worker has failed: every later job runs on the page. */
let workerFailed = false;
let nextJobId = 1;
/** @type {Map<number, {resolve: (result: Snapshot) => void, reject: (error: Error) => void}>} */
const answering = new Map();

/**
 * Give up on the worker, and send whatever it was answering back to the page.
 * @param {string} why - What went wrong, for the console.
 */
function abandonWorker(why) {
  console.warn(`[diff] diff worker unavailable, diffing on the page: ${why}`);
  workerFailed = true;
  worker?.terminate();
  worker = null;
  const waiting = [...answering.values()];
  answering.clear();
  for (const job of waiting) job.reject(new Error(why));
}

/**
 * The diff worker, started on first use. It is handed the Prism scripts this
 * page loaded, so it highlights with the same grammars the page would.
 * @returns {Worker|null} The worker, or null where there can be none.
 */
function diffWorker() {
  if (worker || workerFailed) return worker;
  if (typeof Worker === 'undefined' || typeof document === 'undefined') return null;
  try {
    worker = new Worker(new URL('../workers/diff-worker.js', import.meta.url));
  } catch (error) {
    abandonWorker(extractErrorMessage(error));
    return null;
  }
  const scripts = Array.from(document.querySelectorAll('script[src]'))
    .map((script) => /** @type {HTMLScriptElement} */ (script).src)
    .filter((src) => /\/vendor\/prism-[\w-]+\.js(?:[?#]|$)/.test(src));
  worker.onmessage = (event) => {
    const { id, result, error } = event.data || {};
    const job = answering.get(id);
    if (!job) return;
    answering.delete(id);
    if (error) job.reject(new Error(error));
    else job.resolve(result);
  };
  worker.onerror = (event) => {
    event.preventDefault();
    abandonWorker(event.message || 'worker error');
  };
  worker.postMessage({ type: 'init', scripts });
  return worker;
}

/**
 * Compute one snapshot, in the diff worker where there is one. A job the worker
 * fails is computed on the page instead, and so is every job after it.
 * @param {SnapshotInput} input - The request.
 * @returns {Promise<Snapshot>} Its answer.
 */
function compute(input) {
  const target = diffWorker();
  if (!target) return computeOnPage(input);
  const id = nextJobId++;
  return new Promise((/** @type {(result: Snapshot) => void} */ resolve, reject) => {
    answering.set(id, { resolve, reject });
    target.postMessage({ type: 'job', id, input });
  }).then((result) => {
    snapshotStats.offThread++;
    return result;
  }, (error) => {
    if (!workerFailed) abandonWorker(extractErrorMessage(error));
    return computeOnPage(input);
  });
}

/** Hand out the next job still wanted, if nothing is running. */
function pump() {
  if (running) return;
  const job = queue.shift();
  if (!job) return;
  running = job;
  job.started = true;
  snapshotStats.computed++;
  const settle = (/** @type {Snapshot} */ result) => {
    // Remembered even when every waiter has gone: the reader who stepped past
    // this edit may step back to it.
    remember(job.input, result);
    running = null;
    for (const waiter of job.waiters) waiter(result);
    pump();
  };
  compute(job.input).then(settle, (error) => {
    console.error('[diff] snapshot failed:', error);
    settle({ hunks: null, added: 0, removed: 0 });
  });
}

/**
 * Ask for a snapshot. The answer never arrives inside this call, even when it is
 * already known — a caller that wants the cached answer synchronously asks
 * `cachedSnapshot` first.
 * @param {SnapshotInput} input - The request.
 * @param {(result: Snapshot) => void} onResult - Called with the answer, unless cancelled first.
 * @returns {() => void} Cancel: the answer is not delivered, and a job no one
 *   else is waiting for is dropped if it has not started.
 */
export function requestSnapshot(input, onResult) {
  let job = running && sameInput(running.input, input)
    ? running
    : queue.find((queued) => sameInput(queued.input, input));
  if (!job) {
    job = { input, waiters: new Set(), started: false };
    queue.push(job);
  }
  const owned = job;
  owned.waiters.add(onResult);
  // Handed out from a task of its own, so a viewer that is created and removed
  // in the same task — one step of a held arrow key — cancels before it starts.
  setTimeout(pump, 0);
  return () => {
    owned.waiters.delete(onResult);
    if (!owned.started && owned.waiters.size === 0) {
      const at = queue.indexOf(owned);
      if (at >= 0) queue.splice(at, 1);
    }
  };
}
