//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Tests for the tool invoker (services/tool-invoker.js): how a program
 * tool's `tools.*` calls are admitted, decided, scheduled, cancelled and
 * recorded. The offered set, the decision, the execution and the cancel are
 * injected, so what is under test is the invoker's own rules.
 *
 * Contract under test:
 *   1. A tool the thread was not offered, or one that stays native, is refused
 *      with the worker's wording before anything runs, and the refusal is
 *      catchable.
 *   2. A call the gate would park or deny ends the program: ToolRefused, the
 *      onRefused callback, and every later call refused unrun — never put to
 *      the decision, so no hook of the user's runs for it.
 *   2a. approveNext approves only the call it names, by tool and arguments.
 *   3. A failed call is a catchable ToolError carrying the tool's own text.
 *   4. No more than `limit` calls run at once; the rest queue.
 *   5. Calls keep the program's order: reads overlap, anything else waits for
 *      every earlier call and holds back every later one.
 *   6. Abort cancels every running call and refuses every queued one.
 *   7. The record holds name, clipped args, status, duration, error and effect —
 *      never a result — is bounded, and gives up reads before effects. Only a
 *      call that ran keeps its effect.
 * @module unit-tests/tool-invoker-test
 */

import { assert } from '../utilities/test-helpers.js';
import { createToolInvoker, ToolError, ToolRefused } from '../../js/services/tool-invoker.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

const OFFERED = [
  { name: 'read', category: 'read' },
  { name: 'grep', category: 'read' },
  { name: 'edit', category: 'write' },
  { name: 'bash', category: 'write' },
  { name: 'keep_notes', category: 'meta', composable: false },
  { name: 'other_program', category: 'write', programSdk: true },
];

/**
 * Let queued microtasks and promise chains settle.
 * @returns {Promise<void>} Resolves on the next macrotask
 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * An invoker whose executions are held open until the test releases them.
 * @param {object} [opts]
 * @param {number} [opts.limit]
 * @param {number} [opts.maxRecords]
 * @param {(call: any) => any} [opts.decide] - Decision per call; approve by default
 * @returns {any} The invoker plus its controls
 */
function harness(opts = {}) {
  /** @type {Array<{toolName: string, toolUseId: string, input: any, settle: (r: any) => void}>} */
  const started = [];
  /** @type {any[]} */
  const decided = [];
  /** @type {string[]} */
  const cancelled = [];
  /** @type {any[]} */
  const refusals = [];
  const controller = new AbortController();
  const invoker = createToolInvoker({
    parentToolUseId: 'parent-1',
    signal: controller.signal,
    onRefused: (/** @type {any} */ err) => refusals.push(err),
    limit: opts.limit,
    maxRecords: opts.maxRecords,
    deps: {
      offeredTools: async () => OFFERED,
      decide: async (/** @type {any} */ call) => {
        decided.push(call);
        return opts.decide ? opts.decide(call) : { verdict: 'approve', reason: '' };
      },
      run: (/** @type {any} */ call) => new Promise((resolve) => {
        started.push({ ...call, settle: resolve });
      }),
      cancel: (/** @type {string} */ toolUseId) => {
        cancelled.push(toolUseId);
        const s = started.find((c) => c.toolUseId === toolUseId);
        s?.settle({ success: false, cancelled: true, content: 'Action was cancelled.' });
      },
    },
  });
  /** @returns {string[]} The names of the calls started so far, in order */
  const startedNames = () => started.map((c) => c.toolName);
  /**
   * @param {string} toolName
   * @param {any} [result]
   */
  const finish = (toolName, result = { success: true, content: `${toolName} done` }) => {
    const s = started.find((c) => c.toolName === toolName && !(/** @type {any} */ (c)).done);
    assert(s, `${toolName} should have started`);
    /** @type {any} */ (s).done = true;
    /** @type {any} */ (s).settle(result);
  };
  return { invoker, started, decided, startedNames, finish, cancelled, refusals, controller };
}

/**
 * Await a promise expected to reject, and return what it rejected with.
 * @param {Promise<any>} p
 * @returns {Promise<any>} The rejection
 */
async function rejection(p) {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

/**
 * Run all tool-invoker tests.
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
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  await test('an un-offered tool is refused with the worker wording', async () => {
    const h = harness();
    const err = await rejection(h.invoker.invoke('WebSearch', { query: 'x' }));
    assert(err instanceof ToolError, `expected ToolError, got ${err?.name}`);
    assert(err.message === "Couldn't run WebSearch: it wasn't available in this thread.", `wording: ${err.message}`);
    assert(h.started.length === 0, 'nothing may run');
    assert(h.refusals.length === 0, 'an unavailable tool does not end the program');
    const rec = h.invoker.record.calls[0];
    assert(rec?.name === 'WebSearch' && rec.status === 'error', `recorded: ${JSON.stringify(rec)}`);
  });

  await test('a tool that stays native is refused the same way', async () => {
    const h = harness();
    // Declared not composable, and a program tool: neither is callable from a program.
    for (const name of ['keep_notes', 'other_program']) {
      const err = await rejection(h.invoker.invoke(name, {}));
      assert(err instanceof ToolError && err.message === `Couldn't run ${name}: it wasn't available in this thread.`, `got ${err?.message}`);
    }
    assert(h.started.length === 0, 'nothing may run');
  });

  await test('a parked call ends the program', async () => {
    const h = harness({ decide: () => ({ verdict: 'park', reason: 'it needs your approval' }) });
    const err = await rejection(h.invoker.invoke('bash', { command: 'rm x' }));
    assert(err instanceof ToolRefused, `expected ToolRefused, got ${err?.name}`);
    assert(err.message === "Couldn't run bash: it needs your approval, so call it directly.", `wording: ${err.message}`);
    assert(h.refusals.length === 1, 'onRefused fires once');
    assert(h.invoker.record.calls[0].status === 'refused', 'recorded as refused');
    const later = await rejection(h.invoker.invoke('read', { file_path: 'a' }));
    assert(later instanceof ToolRefused, 'a call after a refusal is refused');
    assert(h.started.length === 0, 'nothing runs after a refusal');
  });

  await test('a denied call ends the program with the hook reason', async () => {
    const h = harness({ decide: () => ({ verdict: 'deny', reason: 'Blocked by hook "g": no' }) });
    const err = await rejection(h.invoker.invoke('bash', { command: 'x' }));
    assert(err instanceof ToolRefused && err.message === 'Couldn\'t run bash: Blocked by hook "g": no', `got ${err?.message}`);
  });

  await test('a denied call releases nothing queued behind it', async () => {
    const h = harness({
      decide: (/** @type {any} */ call) => (call.toolName === 'bash'
        ? { verdict: 'deny', reason: 'Blocked by hook "g": no' } : { verdict: 'approve', reason: '' })
    });
    const denied = h.invoker.invoke('bash', { command: 'x' });
    const behind = h.invoker.invoke('edit', { file_path: 'a' });
    const errs = await Promise.all([rejection(denied), rejection(behind)]);
    await tick();
    assert(errs.every((e) => e instanceof ToolRefused), `both refused: ${errs.map((e) => e?.name)}`);
    assert(h.decided.length === 1 && h.decided[0].toolName === 'bash',
      `the call behind a denial is never put to the decision (its hooks would run): ${h.decided.map((/** @type {any} */ c) => c.toolName)}`);
    const edit = h.invoker.record.calls.find((/** @type {any} */ c) => c.name === 'edit');
    assert(edit?.status === 'refused' && edit.effect === undefined, `it never ran, so it changed nothing: ${JSON.stringify(edit)}`);
  });

  await test('a write interrupted while it is being decided changed nothing', async () => {
    /** @type {(v: any) => void} */
    let release = () => {};
    const h = harness({ decide: () => new Promise((resolve) => { release = resolve; }) });
    const p = h.invoker.invoke('bash', { command: 'rm x' });
    await tick();
    h.controller.abort();
    release({ verdict: 'approve', reason: '' });
    const err = await rejection(p);
    assert(err instanceof ToolRefused, `refused: ${err?.name}`);
    assert(h.started.length === 0, 'it never ran');
    const rec = h.invoker.record.calls[0];
    assert(rec.status === 'cancelled' && rec.effect === undefined, `no effect for a call that never ran: ${JSON.stringify(rec)}`);
  });

  await test('approveNext hands over only the call it names, args and all', async () => {
    const h = harness({ decide: () => ({ verdict: 'park', reason: 'it needs your approval' }) });
    h.invoker.approveNext('bash', { command: 'rm a' }, 'yes');
    const other = await rejection(h.invoker.invoke('bash', { command: 'rm b' }));
    assert(other instanceof ToolRefused, `a call with other args is decided afresh, and parks: ${other?.name}`);
    assert(h.started.length === 0, 'the approval for one call never runs another');

    const g = harness({ decide: () => ({ verdict: 'park', reason: 'it needs your approval' }) });
    g.invoker.approveNext('edit', { new_string: 'n', file_path: 'f', old_string: 'o' }, 'yes');
    const p = g.invoker.invoke('edit', { file_path: 'f', old_string: 'o', new_string: 'n' });
    await tick();
    assert(g.decided.length === 0, 'the approved call is not decided again, whatever its key order');
    g.finish('edit');
    assert(await p === 'edit done', 'and runs');
  });

  await test('an invalid call is a catchable ToolError', async () => {
    const h = harness({ decide: () => ({ verdict: 'invalid', reason: 'Missing required parameter: file_path' }) });
    const err = await rejection(h.invoker.invoke('read', {}));
    assert(err instanceof ToolError && err.message === "Couldn't run read: Missing required parameter: file_path", `got ${err?.message}`);
    assert(h.refusals.length === 0, 'an invalid call does not end the program');
  });

  await test('a failed call is a catchable ToolError with the tool text', async () => {
    const h = harness();
    const p = h.invoker.invoke('bash', { command: 'false' });
    await tick();
    h.finish('bash', { success: false, content: 'exit 1' });
    const err = await rejection(p);
    assert(err instanceof ToolError && err.message === 'exit 1', `got ${err?.name} ${err?.message}`);
    assert(h.invoker.record.calls[0].status === 'error' && h.invoker.record.calls[0].error === 'exit 1', 'recorded as error');
  });

  await test('a successful call resolves to its content', async () => {
    const h = harness();
    const p = h.invoker.invoke('read', { file_path: 'a.js' });
    await tick();
    h.finish('read', { success: true, content: 'file text' });
    assert(await p === 'file text', 'resolves to the content');
    const rec = h.invoker.record.calls[0];
    assert(rec.status === 'ok' && typeof rec.durationMs === 'number', `record: ${JSON.stringify(rec)}`);
    assert(!('result' in rec) && !('content' in rec), 'the record never holds a result');
  });

  await test('a call\'s attachments are handed over only when asked for', async () => {
    const h = harness();
    const ref = { id: 'abc123', mime: 'image/png', bytes: 10, width: 2, height: 3 };
    const plain = h.invoker.invoke('read', { file_path: 'a.png' });
    const detailed = h.invoker.invoke('read', { file_path: 'a.png' }, { withAttachments: true });
    const none = h.invoker.invoke('read', { file_path: 'b.txt' }, { withAttachments: true });
    await tick();
    h.finish('read', { success: true, content: 'Read image a.png', attachments: [ref] });
    h.finish('read', { success: true, content: 'Read image a.png', attachments: [ref] });
    h.finish('read', { success: true, content: 'text' });
    assert(await plain === 'Read image a.png', 'without asking, a call still resolves to its content');
    const got = await detailed;
    assert(got?.content === 'Read image a.png' && got.attachments?.length === 1 && got.attachments[0].id === 'abc123',
      `asked for, the attachments come with the content: ${JSON.stringify(got)}`);
    const bare = await none;
    assert(bare?.content === 'text' && Array.isArray(bare.attachments) && bare.attachments.length === 0,
      `a call with none resolves an empty list: ${JSON.stringify(bare)}`);
    assert(h.invoker.record.calls.every((/** @type {any} */ c) => !('attachments' in c)), 'the record never holds attachments');
  });

  await test('at most `limit` calls run at once', async () => {
    const h = harness({ limit: 4 });
    const ps = [1, 2, 3, 4, 5].map((n) => h.invoker.invoke('read', { file_path: `f${n}` }));
    await tick();
    assert(h.started.length === 4, `4 should start, got ${h.started.length}`);
    h.finish('read');
    await tick();
    assert(h.started.length === 5, 'the fifth starts when one finishes');
    for (let i = 0; i < 4; i++) h.finish('read');
    await Promise.all(ps);
  });

  await test('a write waits for earlier calls and holds later ones', async () => {
    const h = harness();
    const r1 = h.invoker.invoke('read', { file_path: 'a' });
    const r2 = h.invoker.invoke('grep', { pattern: 'x' });
    const w = h.invoker.invoke('edit', { file_path: 'a' });
    const r3 = h.invoker.invoke('read', { file_path: 'a' });
    await tick();
    assert(h.startedNames().join() === 'read,grep', `wave 1: ${h.startedNames()}`);
    h.finish('read');
    await tick();
    assert(h.startedNames().join() === 'read,grep', 'the write waits for every earlier call');
    h.finish('grep');
    await tick();
    assert(h.startedNames().join() === 'read,grep,edit', `wave 2: ${h.startedNames()}`);
    h.finish('edit');
    await tick();
    assert(h.startedNames().join() === 'read,grep,edit,read', `wave 3: ${h.startedNames()}`);
    h.finish('read');
    await Promise.all([r1, r2, w, r3]);
  });

  await test('abort cancels running calls and refuses queued ones', async () => {
    const h = harness({ limit: 2 });
    const ps = [1, 2, 3].map((n) => h.invoker.invoke('read', { file_path: `f${n}` }));
    await tick();
    assert(h.started.length === 2, 'two running');
    h.controller.abort();
    const errs = await Promise.all(ps.map(rejection));
    assert(h.cancelled.length === 2, `both running calls cancelled, got ${h.cancelled}`);
    assert(h.started.length === 2, 'the queued call never starts');
    assert(errs.every((e) => e instanceof ToolRefused), `all refused: ${errs.map((e) => e?.name)}`);
    assert(h.invoker.record.calls.every((/** @type {any} */ c) => c.status === 'cancelled'), 'all recorded as cancelled');
  });

  await test('args are clipped and effects named', async () => {
    const h = harness();
    const p1 = h.invoker.invoke('bash', { command: 'npm test', note: 'x'.repeat(1000) });
    await tick();
    h.finish('bash');
    await p1;
    const p2 = h.invoker.invoke('read', { file_path: 'src/a.js' });
    await tick();
    h.finish('read');
    await p2;
    const [bash, read] = h.invoker.record.calls;
    assert(bash.args.note.length <= 501, `clipped to 500 + ellipsis, got ${bash.args.note.length}`);
    assert(bash.effect === 'bash: npm test', `effect: ${bash.effect}`);
    assert(read.effect === undefined, 'a read has no effect');
  });

  await test('the record is bounded and keeps effects over reads', async () => {
    const h = harness({ maxRecords: 3 });
    for (const [name, args] of /** @type {Array<[string, any]>} */ ([
      ['read', { file_path: 'a' }], ['read', { file_path: 'b' }],
      ['edit', { file_path: 'a' }], ['edit', { file_path: 'b' }], ['edit', { file_path: 'c' }],
    ])) {
      const p = h.invoker.invoke(name, args);
      await tick();
      h.finish(name);
      await p;
    }
    const rec = h.invoker.record;
    assert(rec.calls.length === 3, `bounded to 3, got ${rec.calls.length}`);
    assert(rec.calls.every((/** @type {any} */ c) => c.name === 'edit'), `effects kept: ${rec.calls.map((/** @type {any} */ c) => c.name)}`);
    assert(rec.omitted === 2 && rec.omittedEffects === 0, `omitted ${rec.omitted}/${rec.omittedEffects}`);
  });

  return { passed, failed, errors };
}
