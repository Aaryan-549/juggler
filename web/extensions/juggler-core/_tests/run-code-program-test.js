//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * run_code programs run for real: the real sandbox, the real invoker, the real
 * approval decision under YOLO's real policy, the real executor, real files and
 * real shell commands. Only the model is absent — the item is driven directly,
 * so each case can stop it where it needs to (integration:run-code-* drive it
 * through the worker). What the model reads back is getSummary's
 * text followed by the change report the worker's projection builds from the
 * item's call record (programChangeReport), which is asserted here as it would
 * be sent.
 *
 * Contract under test:
 *   1. A program reads files with `fs` and edits one with `tools.edit`: the
 *      edit is admitted on the program's own live read, the file changes, the
 *      model is told the value and the change and nothing about the reads, and
 *      the item carries one row for the one call. The change comes from the
 *      record, never from the program's own summary.
 *   2. A tool the thread was not offered is refused in the worker's words, as
 *      an error the program may catch, and creates no item.
 *   3. A call a hook denies ends the program even when it tries to catch the
 *      refusal, and the model is still told what the program changed before
 *      it stopped.
 *   4. Cancelling the program while a sub-call runs stops the sandbox and the
 *      sub-call, promptly, and leaves nothing running. The record says the
 *      call was interrupted, and nothing writes to it once the program has
 *      ended.
 *   5. Writes keep the program's order even when it fires them together.
 *   6. A program run with a journal replays: each recorded call is answered
 *      from it and nothing recorded runs again. A replay that diverges ends
 *      the program unrun. A program that completes leaves no journal behind.
 *   7. A call the decision parks suspends the program: the item is pending
 *      with that call's own approval and no result, and its card is drawn as
 *      the call's tool draws it. Approving replays it to the end, each call
 *      once, saving any "don't ask again" rule for the sub-tool. A suspended
 *      program with no journal fails and runs nothing; a strategy switch
 *      re-decides the held call; a question's answer is its call's result.
 * @module unit-tests/run-code-program-test
 */

import {
  initializeRegistries,
  createTestSession,
  createApprovalTestConversation,
  assert
} from '../../../js-tests/utilities/test-helpers.js';
import { budgetFor } from '../../../js-tests/utilities/test-deadline.js';
import { createToolActionMessage } from '../../../sdk/lib/message.js';
import { writeFileOp, readFileLoad } from '../../../js/services/ops-api.js';
import actionExecutor from '../../../js/services/action-executor.js';
import contextItemRegistry from '../../../js/registries/context-item-registry.js';
import YoloStrategyType from '../strategies/yolo-strategy-type.js';
import RunCodeContextItem, { programJournals } from '../context-items/run-code-context-item.js';
import QueryCodeContextItem from '../context-items/query-code-context-item.js';
import { programChangeReport } from '../../../js/utils/program-changes.js';
import {
  decideToolCall,
  executeToolAction,
  claimRunning,
  saveAutoApprovalPermission
} from '../../../js/model/conversation-tool-actions.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

let seq = 0;

/**
 * Wait until `predicate` holds, within this test's budget.
 * @param {() => boolean} predicate - What to wait for
 * @param {string} what - Named in the failure
 * @param {number} [nominalMs] - Nominal timeout
 * @returns {Promise<void>}
 */
async function waitUntil(predicate, what, nominalMs = 10000) {
  const until = Date.now() + budgetFor(nominalMs);
  while (!predicate()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Sub-calls of any program still registered as running in the executor.
 * @returns {string[]} Their tool-use ids
 */
function runningSubCalls() {
  return [.../** @type {any} */ (actionExecutor)._runningActions.values()]
    .map((r) => r.toolUseId)
    .filter((id) => typeof id === 'string' && id.startsWith('code_'));
}

/**
 * Run all run_code program tests.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Pass/fail counts
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  await initializeRegistries();
  const session = await createTestSession();

  const prevEngine = /** @type {any} */ (globalThis).JUGGLER_ENGINE;
  /** @type {any} */ (globalThis).JUGGLER_ENGINE = true;

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

  /**
   * A conversation with a run_code tool-action in it, and the item that runs
   * as that action.
   * @param {string} code - The program
   * @param {{strategy?: 'yolo'|'default', toolUseId?: string}} [opts] - The thread's policy (YOLO by default), and the call's id
   * @returns {Promise<{conversation: any, mt: any, item: any, controller: AbortController}>} The setup
   */
  const setup = async (code, opts = {}) => {
    const strategy = opts.strategy ?? 'yolo';
    const conversation = await createApprovalTestConversation(session);
    const mt = conversation.rootMessageThread;
    // Under the default policy each tool's own rule decides: the helper's
    // conversation permits edits and leaves bash to ask.
    mt.strategy = strategy === 'yolo' ? { getApprovalPolicy: YoloStrategyType.prototype.getApprovalPolicy } : {};
    const toolUseId = opts.toolUseId ?? `rc${++seq}_${Date.now()}`;
    // Seeded pending: the conversation's worker is live and commands an
    // unevaluated or approved item into the engine, which would run this
    // program alongside the test. Pending is left to the user, so only the
    // test moves it (runAsAction).
    mt.addEvent(createToolActionMessage({ toolUseId, toolName: 'run_code', toolInput: { code }, state: 'pending' }));
    const controller = new AbortController();
    const item = new RunCodeContextItem({
      id: RunCodeContextItem.MANIFEST.id,
      session,
      conversation,
      messageThread: mt,
      toolUseId,
      signal: controller.signal
    });
    return { conversation, mt, item, controller };
  };

  /**
   * The item's displayData: its call record.
   * @param {any} mt - Thread
   * @param {string} toolUseId - The program's id
   * @returns {any} The record, plain
   */
  const displayOf = (mt, toolUseId) => {
    const display = mt.getToolAction(toolUseId)?.get('displayData');
    return display?.toJSON ? display.toJSON() : display;
  };

  /**
   * Run a program to completion and return what the model would read.
   * @param {any} item - The run_code item
   * @param {string} code - The program
   * @returns {Promise<{out: any, text: string, wire: string}>} The raw result,
   *   the item's own summary, and the tool_result the model is sent (the
   *   summary plus the worker's change report)
   */
  const run = async (item, code) => {
    const out = await item.execute({ code });
    const outcome = out?.success === false
      ? { success: false, error: out.error, result: out }
      : { success: true, result: out };
    const summary = item.getSummary(outcome);
    const text = String(summary.summary);
    return { out, text, summary, wire: text + programChangeReport(displayOf(item.messageThread, item.toolUseId)) };
  };

  /**
   * What the item holds in the asset store, by id.
   * @param {any} mt - Thread
   * @param {string} toolUseId - The program's id
   * @returns {string[]} Its heldAssets
   */
  const heldOf = (mt, toolUseId) => {
    const held = mt.getToolAction(toolUseId)?.get('heldAssets');
    return (held?.toJSON ? held.toJSON() : held) || [];
  };

  /**
   * The rows the item shows for its calls.
   * @param {any} mt - Thread
   * @param {string} toolUseId - The program's id
   * @returns {any[]} Recorded calls
   */
  const rowsOf = (mt, toolUseId) => {
    const data = displayOf(mt, toolUseId);
    return Array.isArray(data?.nestedCalls) ? data.nestedCalls : [];
  };

  /**
   * Run `fn` with the sub-call decision overridden wherever `override` returns
   * a verdict; anything else goes to the real decision.
   * @template T
   * @param {(call: any) => {verdict: string, reason: string}|null} override - The override
   * @param {() => Promise<T>} fn - What to run under it
   * @returns {Promise<T>} fn's result
   */
  const withDecision = async (override, fn) => {
    const g = /** @type {any} */ (globalThis);
    const host = g.__hostToolInvoker;
    g.__hostToolInvoker = (/** @type {any} */ opts) => host({
      ...opts,
      deps: {
        decide: async (/** @type {any} */ call) => override(call)
          ?? decideToolCall({ messageThread: opts.messageThread, conversation: opts.conversation, ...call })
      }
    });
    try {
      return await fn();
    } finally {
      g.__hostToolInvoker = host;
    }
  };

  /**
   * A command that appends `x` to `log` and prints `ran`, wrapped in a shell
   * so the helper conversation's file-writing grant does not cover it.
   * @param {string} log - The file it appends to
   * @returns {string} The command
   */
  const heldCommand = (log) => `sh -c 'printf x >> ${log}'; printf ran`;

  /**
   * Fail unless the real decision parks `command` in this thread.
   * @param {any} conversation - Conversation
   * @param {any} mt - Thread
   * @param {string} command - The command
   * @returns {Promise<void>}
   */
  const assertParks = async (conversation, mt, command) => {
    const d = await decideToolCall({ messageThread: mt, conversation, toolName: 'bash', toolInput: { command }, toolUseId: `probe_${++seq}` });
    assert(d.verdict === 'park', `precondition: ${command} must park here, got ${d.verdict}`);
  };

  /**
   * Run the program as the engine runs an approved tool-action: claim it
   * (approved → running), then the execute path, whose exit writes the item.
   * `answer` (the user's answer, or a reset) is written in the same transaction
   * as the approval and the claim, so the live worker never sees the item
   * approved and unclaimed, which it would command into the engine.
   * @param {any} conversation - Conversation
   * @param {any} mt - Thread
   * @param {string} toolUseId - The program's id
   * @param {() => void} [answer] - Written first, in the same transaction
   * @returns {Promise<any>} The tool-action, plain, once the pass has ended
   */
  const runAsAction = async (conversation, mt, toolUseId, answer) => {
    const ymap = mt.getToolAction(toolUseId);
    let claimed = false;
    mt.transact(() => {
      answer?.();
      if ((ymap.get('state') ?? '') !== 'approved') mt.updateToolActionState(toolUseId, 'approved');
      if (ymap.get('approvalResponse') === 'yes-always') saveAutoApprovalPermission(conversation, ymap, mt);
      claimed = claimRunning(conversation, ymap);
    });
    assert(claimed, 'the claim must succeed');
    await executeToolAction(mt, toolUseId, conversation);
    return mt.getToolAction(toolUseId).toJSON();
  };

  try {
    await test('fs reads then tools.edit: admitted, applied, reported', async () => {
      const dir = `rc-edit-${Date.now()}`;
      await writeFileOp({ path: `${dir}/a.txt`, content: 'alpha\n' });
      await writeFileOp({ path: `${dir}/b.txt`, content: 'beta\n' });
      await writeFileOp({ path: `${dir}/c.txt`, content: 'hello world\n' });
      const code = `
        const a = await fs.readFile("${dir}/a.txt");
        const b = await fs.readFile("${dir}/b.txt");
        const c = await fs.readFile("${dir}/c.txt");
        await tools.edit({ file_path: "${dir}/c.txt", old_string: "world", new_string: "there" });
        return a.length + b.length + c.length;`;
      const { mt, item } = await setup(code);
      const before = mt.items.length;
      const { out, text, wire } = await run(item, code);
      assert(out?.success !== false, `the program must succeed, got: ${text}`);
      const after = await readFileLoad({ path: `${dir}/c.txt` });
      assert(String(after.content).includes('hello there'), `the edit must apply, file is: ${after.content}`);
      assert(wire.startsWith('23'), `the model reads the value first, got: ${wire}`);
      assert(wire.includes(`Changes the program made:\n- edit: ${dir}/c.txt`), `the change must be listed:\n${wire}`);
      assert(!wire.includes('a.txt') && !wire.includes('b.txt'), `reads are never listed:\n${wire}`);
      assert(!text.includes('Changes the program made'), `the list comes from the record, not the summary:\n${text}`);
      assert(!('effects' in out), `the result carries no change list of its own: ${JSON.stringify(out)}`);
      assert(mt.items.length === before, 'a sub-call creates no item');
      const rows = rowsOf(mt, item.toolUseId);
      assert(rows.length === 1 && rows[0].name === 'edit' && rows[0].status === 'ok', `rows: ${JSON.stringify(rows)}`);
      assert(!('result' in rows[0]), 'a row never holds a result');
      const display = displayOf(mt, item.toolUseId);
      assert(display.omittedEffects === 0, `the record counts the effects it gave up: ${JSON.stringify(display)}`);
    });

    await test('an un-offered tool is refused in the worker\'s words', async () => {
      const code = `
        try { await tools.create_thread({ goal: "x", prompt: "y" }); return "ran"; }
        catch (e) { return e.message; }`;
      const { mt, item } = await setup(code);
      const before = mt.items.length;
      const { text } = await run(item, code);
      assert(text.includes("Couldn't run create_thread: it wasn't available in this thread."), `got: ${text}`);
      assert(mt.items.length === before, 'no item is created');
      const rows = rowsOf(mt, item.toolUseId);
      assert(rows.length === 1 && rows[0].status === 'error', `rows: ${JSON.stringify(rows)}`);
    });

    // Models write Node out of habit: import or require fs, declare their own
    // `fs`, write through it. Each fails; the error must say what to use
    // instead, or the model retries the same mistake and falls back to native
    // tools (measured: 7 of Haiku's 8 programs, on exactly these).
    await test('Node habits are pointed at what is already in scope', async () => {
      const inScope = 'path, projectRoot, fs, grep, glob, tools, describeTool, image';
      const cases = [
        {
          code: 'const fs = await import("fs");\nreturn 1;',
          wants: ["Cannot declare a const variable twice: 'fs'. It is already in scope: use it directly rather than importing or requiring it.", `In scope: ${inScope}.`],
        },
        {
          code: 'return require("path");',
          wants: [`Couldn't require "path": this sandbox is not Node. Use what is already in scope instead: ${inScope}.`],
        },
        {
          code: 'const m = await import("node:fs");\nreturn 1;',
          wants: [`Couldn't import "node:fs": this sandbox is not Node. Use what is already in scope instead: ${inScope}.`],
        },
        {
          code: `await fs.writeFile("rc-erofs-${Date.now()}.txt", "x");\nreturn 1;`,
          wants: ['EROFS: read-only filesystem', 'change files with tools.write or tools.edit'],
        },
      ];
      for (const { code, wants } of cases) {
        const { item } = await setup(code);
        const { out, text } = await run(item, code);
        assert(out?.success === false, `must fail: ${code}\ngot: ${text}`);
        for (const want of wants) assert(text.includes(want), `for ${JSON.stringify(code)} the error must say:\n${want}\ngot:\n${text}`);
      }
    });

    // The SDK in run_code's description is an index; describeTool is where a
    // program gets the rest, over exactly what the thread may call.
    await test('describeTool describes what the program may call, and nothing else', async () => {
      const code = `
        const edit = await describeTool("edit");
        const all = await describeTool();
        let refused = "";
        try { await describeTool("create_thread"); } catch (e) { refused = e.message; }
        return { edit, all, refused };`;
      const { item } = await setup(code);
      const { out, text } = await run(item, code);
      assert(out?.success !== false, `must succeed, got: ${text}`);
      const value = /** @type {any} */ (out).result;
      assert(String(value.edit).includes('tools.edit(args)') && String(value.edit).includes('args.old_string'), `edit's whole entry:\n${value.edit}`);
      assert(Array.isArray(value.all) && value.all.includes('edit') && value.all.includes('bash'), `the callable names: ${JSON.stringify(value.all)}`);
      assert(!value.all.includes('create_thread'), 'a native-only tool is not callable from a program');
      assert(value.refused.includes('create_thread') && value.refused.includes("can't be called from a program"), `got: ${value.refused}`);
    });

    await test('a hook\'s deny ends the program, changes still reported', async () => {
      const file = `rc-deny-${Date.now()}.txt`;
      const code = `
        await tools.bash({ command: "printf done > ${file}" });
        try { await tools.bash({ command: "echo blocked" }); }
        catch (e) { return "caught: " + e.message; }
        return "unreachable";`;
      const { mt, item } = await setup(code);
      // A deny is the one verdict that still refuses: the user's own gate said
      // no, so there is nothing to wait for.
      const deny = (/** @type {any} */ call) => (call.toolInput?.command === 'echo blocked'
        ? { verdict: 'deny', reason: 'Blocked by hook "t"' } : null);
      const { out, text, wire } = await withDecision(deny, () => run(item, code));
      assert(out?.success === false, `a refusal must not be catchable, got: ${text}`);
      assert(text.includes('Couldn\'t run bash: Blocked by hook "t"'), `got: ${text}`);
      assert(wire.includes(`Changes the program made:\n- bash: printf done > ${file}`), `the earlier change must be reported:\n${wire}`);
      assert(!text.includes('Changes the program made'), `the list comes from the record, not the summary:\n${text}`);
      const rows = rowsOf(mt, item.toolUseId);
      assert(rows.some((r) => r.name === 'bash' && r.status === 'refused'), `rows: ${JSON.stringify(rows)}`);
      assert(!programJournals.has(item), 'a refused program leaves no journal');
    });

    await test('cancelling stops the sandbox and the running sub-call', async () => {
      const code = 'await tools.bash({ command: "sleep 30" }); return "finished";';
      const { mt, item, controller } = await setup(code);
      const execution = item.execute({ code });
      execution.catch(() => {});
      await waitUntil(() => runningSubCalls().length > 0, 'the sub-call to start');
      const started = Date.now();
      controller.abort();
      let threw = false;
      try {
        await execution;
      } catch {
        threw = true;
      }
      assert(threw, 'a cancelled program rejects');
      assert(Date.now() - started < 10000, `cancel must be prompt, took ${Date.now() - started}ms`);
      await waitUntil(() => runningSubCalls().length === 0, 'no sub-call left running');
      const rows = rowsOf(mt, item.toolUseId);
      assert(rows.length === 1 && rows[0].status === 'cancelled', `rows: ${JSON.stringify(rows)}`);
      const report = programChangeReport(displayOf(mt, item.toolUseId));
      assert(report === '\n\nChanges the program made:\n- bash: sleep 30 (interrupted)', `the cut-off call is reported: ${JSON.stringify(report)}`);
      // The record is final once the program has ended: the worker has already
      // written the cancelled state, and the model is sent this record. Rows
      // are written on a 250ms throttle, so a write still scheduled would land
      // inside this window.
      const final = JSON.stringify(displayOf(mt, item.toolUseId));
      await new Promise((resolve) => setTimeout(resolve, 600));
      const later = JSON.stringify(displayOf(mt, item.toolUseId));
      assert(later === final, `the record was written after the program ended:\n${final}\n→ ${later}`);
    });

    // A program that suspended for an approval is run again from the top; the
    // journal is what makes that safe. These seed one directly, as a suspended
    // pass would have left it.
    await test('a replay answers from the journal and runs nothing again', async () => {
      const file = `rc-replay-${Date.now()}.txt`;
      const code = `
        const a = await fs.readFile("never-read-${file}");
        const r = await tools.bash({ command: "printf x > ${file}" });
        return a + "|" + r;`;
      const { mt, item } = await setup(code);
      programJournals.set(item, {
        journal: [
          { key: 'fs.readFile', args: JSON.stringify([`never-read-${file}`]), ok: true, value: 'from the journal' },
          { key: 'tools.bash', args: JSON.stringify([{ command: `printf x > ${file}` }]), ok: true, value: 'ran before' },
        ],
        record: {
          calls: [{ name: 'bash', args: { command: `printf x > ${file}` }, status: 'ok', durationMs: 5, effect: `bash: printf x > ${file}` }],
          omitted: 0,
          omittedEffects: 0,
        },
      });
      const { out, text, wire } = await run(item, code);
      assert(out?.success !== false, `must succeed, got: ${text}`);
      assert(text === 'from the journal|ran before', `the program sees the journal's answers, got: ${text}`);
      // The earlier pass's change still reaches the model: the record spans passes.
      assert(wire.includes(`Changes the program made:\n- bash: printf x > ${file}`), `the earlier pass's change must be reported:\n${wire}`);
      const rows = rowsOf(mt, item.toolUseId);
      assert(rows.length === 1 && rows[0].name === 'bash', `one row for the one call, across passes: ${JSON.stringify(rows)}`);
      const written = await readFileLoad({ path: file }).catch(() => null);
      assert(written === null || written.exists === false, `bash must not run again, but ${file} exists`);
      assert(!programJournals.has(item), 'a completed program leaves no journal');
    });

    await test('a replay that diverges ends the program unrun', async () => {
      const file = `rc-diverge-${Date.now()}.txt`;
      const code = `
        try { await tools.bash({ command: "printf x > ${file}" }); }
        catch (e) { return "caught: " + e.message; }
        return "unreachable";`;
      const { item } = await setup(code);
      programJournals.set(item, {
        journal: [
          { key: 'tools.bash', args: JSON.stringify([{ command: 'printf y > elsewhere.txt' }]), ok: true, value: 'ran before' },
        ],
        record: { calls: [], omitted: 0, omittedEffects: 0 },
      });
      const { out, text } = await run(item, code);
      assert(out?.success === false, `a divergence must not be catchable, got: ${text}`);
      assert(text.includes("Couldn't resume the program") && text.includes('step 1'), `got: ${text}`);
      const written = await readFileLoad({ path: file }).catch(() => null);
      assert(written === null || written.exists === false, `bash must not run, but ${file} exists`);
      assert(!programJournals.has(item), 'an ended program leaves no journal');
    });

    // Tool-use ids are unique within a conversation, not across them: two
    // conversations' calls can share one, and the engine holds every
    // conversation's journals.
    await test('a journal belongs to its own conversation\'s program', async () => {
      const file = `rc-own-${Date.now()}.txt`;
      const code = `return await tools.bash({ command: "printf x > ${file}; printf ran" });`;
      const toolUseId = `rc-shared-${Date.now()}`;
      const other = await setup(code, { toolUseId });
      const { item } = await setup(code, { toolUseId });
      programJournals.set(other.item, {
        journal: [{ key: 'tools.bash', args: JSON.stringify([{ command: 'printf y > elsewhere.txt' }]), ok: true, value: 'theirs' }],
        record: { calls: [], omitted: 0, omittedEffects: 0 },
      });
      try {
        const { out, text } = await run(item, code);
        assert(out?.success !== false && text.startsWith('ran'), `it runs as a fresh program, got: ${text}`);
        const written = await readFileLoad({ path: file });
        assert(String(written.content) === 'x', `its call ran: ${JSON.stringify(written.content)}`);
        assert(programJournals.has(other.item), 'the other conversation\'s journal is untouched');
      } finally {
        programJournals.delete(other.item);
      }
    });

    // Under a strategy that asks, a sub-call the decision would park suspends
    // the program: the item goes back to pending carrying that call's own
    // approval, and approving it replays the program to the end.
    await test('a parked call suspends; approving it replays to the end, each call once', async () => {
      const dir = `rc-suspend-${Date.now()}`;
      await writeFileOp({ path: `${dir}/c.txt`, content: 'hello world\n' });
      const log = `${dir}/log.txt`;
      const command = heldCommand(log);
      const code = `
        const c = await fs.readFile("${dir}/c.txt");
        await tools.edit({ file_path: "${dir}/c.txt", old_string: "world", new_string: "there" });
        const r = await tools.bash({ command: ${JSON.stringify(command)} });
        return c.trim() + "|" + String(r).trim();`;
      const { conversation, mt, item } = await setup(code, { strategy: 'default' });
      const id = item.toolUseId;
      await assertParks(conversation, mt, command);

      const parked = await runAsAction(conversation, mt, id);
      assert(parked.state === 'pending', `the item must go back to pending, is ${parked.state}`);
      assert(parked.result === undefined, `a suspended item has no result: ${JSON.stringify(parked.result)}`);
      assert(parked.suspendedCall?.name === 'bash', `the held call is named: ${JSON.stringify(parked.suspendedCall)}`);
      assert(parked.suspendedCall?.input?.command === command, `with its input: ${JSON.stringify(parked.suspendedCall)}`);
      const options = parked.approvalOptions?.options || [];
      assert(options.some((/** @type {any} */ o) => o.value === 'yes') && options.some((/** @type {any} */ o) => o.value === 'no'), `yes and no: ${JSON.stringify(options)}`);
      const always = options.filter((/** @type {any} */ o) => String(o.value).startsWith('yes-always'));
      assert(always.length > 0, `bash's own "don't ask again" buttons: ${JSON.stringify(options)}`);
      assert(always.every((/** @type {any} */ o) => o.rules && o.itemType && o.itemType !== 'run-code'), `each carries its rule, for the sub-tool: ${JSON.stringify(always)}`);
      const edited = await readFileLoad({ path: `${dir}/c.txt` });
      assert(String(edited.content).includes('hello there'), 'the edit before the stop ran');
      assert((await readFileLoad({ path: log }).catch(() => null))?.exists !== true, 'the held call did not run');
      assert(programJournals.has(item), 'a suspended program keeps its journal');
      const before = rowsOf(mt, id).map((r) => `${r.name}:${r.status}`).join(',');
      assert(before === 'edit:ok', `the rows hold what ran: ${before}`);

      // The card is drawn by run_code's class; while suspended it shows the
      // held call as bash itself would, in the transcript and in the panel.
      const ui = item.getStatusUI({ pending: true, state: 'pending' }, { code }, { conversation, messageThread: mt, toolUseId: id });
      const bashUi = new (/** @type {any} */ (contextItemRegistry.getByToolName('bash')))({ id: 'execute', session, conversation, messageThread: mt })
        .getStatusUI({ pending: true, state: 'pending' }, { command }, { conversation, messageThread: mt, toolUseId: id });
      const textOf = (/** @type {any} */ s) => (typeof s === 'string' ? s : s?.textContent);
      assert(textOf(ui?.summary) === textOf(bashUi?.summary) && String(textOf(ui?.summary)).includes(log),
        `the status row is bash's: ${textOf(ui?.summary)} vs ${textOf(bashUi?.summary)}`);
      assert(String(ui?.typeName).startsWith('Program'), `and says it is the program's: ${JSON.stringify(ui)}`);
      /** @type {Array<[string, string]>} */
      const sections = [];
      const helpers = new Proxy({}, {
        get: (_t, name) => (/** @type {any} */ _w, /** @type {any} */ title, /** @type {any} */ body) => {
          sections.push([String(name), `${title}: ${typeof body === 'string' ? body : ''}`]);
        }
      });
      item.renderToolActionDetails(document.createElement('div'), /** @type {any} */ ({
        toolAction: mt.getToolAction(id), toolName: 'run_code', input: { code }, helpers,
        conversation, messageThread: mt, session, selectedItemId: null
      }));
      assert(sections.some(([, s]) => s.startsWith('Command:') && s.includes(log)), `the panel shows the held command: ${JSON.stringify(sections)}`);

      const button = always[0];
      let written = false;
      const done = await runAsAction(conversation, mt, id, () => {
        written = mt.resolveApproval(id, 'yes-always', {
          approvalRules: button.rules, approvalItemType: button.itemType, source: 'user'
        });
      });
      assert(written, 'the approval is written');
      assert(done.state === 'completed' && !done.result?.isError, `the program finishes: ${JSON.stringify(done.result)}`);
      assert(done.result?.content === 'hello world|ran', `it saw the journal's read and the real run: ${done.result?.content}`);
      const ran = await readFileLoad({ path: log });
      assert(String(ran.content) === 'x', `bash ran exactly once: ${JSON.stringify(ran.content)}`);
      const after = rowsOf(mt, id).map((r) => `${r.name}:${r.status}`).join(',');
      assert(after === 'edit:ok,bash:ok', `one row per call, across passes: ${after}`);
      assert(!programJournals.has(item), 'a finished program leaves no journal');
      assert(!done.suspendedCall, 'nor a held call');
      const again = await decideToolCall({
        messageThread: mt, conversation, toolName: 'bash',
        toolInput: { command }, toolUseId: `${id}_again`
      });
      assert(again.verdict === 'approve', `"don't ask again" saved a bash rule: ${again.verdict}`);
    });

    // The journal a real pass leaves, not one written by hand: concurrent
    // reads, searches and edits, then a call that waits. Every answer it holds
    // carries its place in the order the program got them, so the replay can
    // give them back in it; the edits ran once, before the stop, and are
    // answered from the journal after it.
    await test('a real pass with concurrent calls leaves a journal its replay finishes from', async () => {
      const dir = `rc-real-${Date.now()}`;
      const names = ['a', 'b', 'c'];
      for (const [i, n] of names.entries()) await writeFileOp({ path: `${dir}/${n}.txt`, content: `hello ${i}\n` });
      const log = `${dir}/log.txt`;
      const command = heldCommand(log);
      const code = `
        const files = ${JSON.stringify(names.map((n) => `${dir}/${n}.txt`))};
        const texts = await Promise.all(files.map((f) => fs.readFile(f)));
        const [hits, listed] = await Promise.all([grep("hello", { cwd: "${dir}" }), glob("*.txt", { cwd: "${dir}" })]);
        await Promise.all(files.map(async (f) => {
          await fs.readFile(f);
          await tools.edit({ file_path: f, old_string: "hello", new_string: "there" });
        }));
        const r = await tools.bash({ command: ${JSON.stringify(command)} });
        const after = await Promise.all(files.map((f) => fs.readFile(f)));
        return JSON.stringify({ texts, hits: hits.length, listed: listed.length, r: String(r).trim(), after });`;
      const { conversation, mt, item } = await setup(code, { strategy: 'default' });
      const id = item.toolUseId;
      await assertParks(conversation, mt, command);
      const parked = await runAsAction(conversation, mt, id);
      assert(parked.state === 'pending' && parked.suspendedCall?.name === 'bash', `suspended on bash: ${parked.state} ${JSON.stringify(parked.suspendedCall)}`);
      const journal = /** @type {any[]} */ (programJournals.get(item)?.journal ?? []);
      const keys = Array.from(journal, (e) => e?.key ?? '<gap>');
      assert(JSON.stringify(keys.slice(0, 3)) === JSON.stringify(['fs.readFile', 'fs.readFile', 'fs.readFile'])
        && keys.at(-1) === 'tools.bash' && keys.length === 12 && !keys.includes('<gap>'),
      `every call before the stop is journalled, the held one last: ${JSON.stringify(keys)}`);
      const answered = journal.slice(0, -1);
      assert(answered.every((e) => typeof e.seq === 'number' && !e.held) && journal.at(-1).held,
        `each answer has its place in the order, the held call none: ${JSON.stringify(journal.map((e) => [e.key, e.seq, e.held]))}`);
      assert(new Set(answered.map((e) => e.seq)).size === answered.length, 'no two answers share a place');
      for (const n of names) {
        const now = await readFileLoad({ path: `${dir}/${n}.txt` });
        assert(String(now.content).startsWith('there'), `${n} was edited before the stop: ${now.content}`);
      }

      const done = await runAsAction(conversation, mt, id, () => mt.resolveApproval(id, 'yes', { source: 'user' }));
      assert(done.state === 'completed' && !done.result?.isError, `the replay finishes: ${JSON.stringify(done.result)}`);
      const value = JSON.parse(String(done.result?.content));
      assert(JSON.stringify(value.texts) === JSON.stringify(['hello 0\n', 'hello 1\n', 'hello 2\n']), `it saw what it read before the stop: ${JSON.stringify(value.texts)}`);
      assert(value.hits === 3 && value.listed === 3 && value.r === 'ran', `and its searches and the command: ${JSON.stringify(value)}`);
      assert(JSON.stringify(value.after) === JSON.stringify(['there 0\n', 'there 1\n', 'there 2\n']), `each edit applied once: ${JSON.stringify(value.after)}`);
      assert(String((await readFileLoad({ path: log })).content) === 'x', 'the command ran once');
      const rows = rowsOf(mt, id).map((r) => `${r.name}:${r.status}`).join(',');
      assert(rows === 'edit:ok,edit:ok,edit:ok,bash:ok', `one row per call, across passes: ${rows}`);
    });

    // Two calls that wait, fired together: the program stops on one, its
    // replay is handed that one and stops on the other, and the third pass
    // finishes. Each command runs once, whichever the invoker reached first.
    await test('two waiting calls fired together suspend in turn, and each runs once', async () => {
      const dir = `rc-twice-${Date.now()}`;
      await writeFileOp({ path: `${dir}/c.txt`, content: 'seed\n' });
      const commands = [1, 2].map((n) => heldCommand(`${dir}/log${n}.txt`));
      const code = `
        const out = await Promise.all(${JSON.stringify(commands)}.map(async (command) => {
          await fs.readFile("${dir}/c.txt");
          return String(await tools.bash({ command })).trim();
        }));
        return out.join("|");`;
      const { conversation, mt, item } = await setup(code, { strategy: 'default' });
      const id = item.toolUseId;
      for (const c of commands) await assertParks(conversation, mt, c);
      const first = await runAsAction(conversation, mt, id);
      assert(first.state === 'pending', `the first stop: ${first.state} ${JSON.stringify(first.result)}`);
      const second = await runAsAction(conversation, mt, id, () => mt.resolveApproval(id, 'yes', { source: 'user' }));
      assert(second.state === 'pending', `the second stop: ${second.state} ${JSON.stringify(second.result)}`);
      const held = [first, second].map((p) => p.suspendedCall?.input?.command);
      assert(held.every((c) => commands.includes(c)) && held[0] !== held[1], `it stops once on each command: ${JSON.stringify(held)}`);
      const done = await runAsAction(conversation, mt, id, () => mt.resolveApproval(id, 'yes', { source: 'user' }));
      assert(done.state === 'completed' && done.result?.content === 'ran|ran', `the third pass finishes: ${JSON.stringify(done.result)}`);
      for (const n of [1, 2]) {
        const ran = await readFileLoad({ path: `${dir}/log${n}.txt` });
        assert(String(ran.content) === 'x', `command ${n} ran once: ${JSON.stringify(ran.content)}`);
      }
      const rows = rowsOf(mt, id).map((r) => `${r.name}:${r.status}`).join(',');
      assert(rows === 'bash:ok,bash:ok', `one row per command: ${rows}`);
      assert(!programJournals.has(item) && !done.suspendedCall, 'nothing left behind');
    });

    await test('a suspended program with no journal fails and runs nothing', async () => {
      const dir = `rc-lost-${Date.now()}`;
      await writeFileOp({ path: `${dir}/c.txt`, content: 'hello world\n' });
      const log = `${dir}/log.txt`;
      const command = heldCommand(log);
      const code = `
        await fs.readFile("${dir}/c.txt");
        await tools.edit({ file_path: "${dir}/c.txt", old_string: "world", new_string: "there" });
        await tools.bash({ command: ${JSON.stringify(command)} });
        return "finished";`;
      const { conversation, mt, item } = await setup(code, { strategy: 'default' });
      const id = item.toolUseId;
      await assertParks(conversation, mt, command);
      const parked = await runAsAction(conversation, mt, id);
      assert(parked.state === 'pending', `suspended first: ${parked.state}`);
      // What a restart leaves: the item as it was, the journal gone.
      programJournals.delete(item);
      const done = await runAsAction(conversation, mt, id, () => mt.resolveApproval(id, 'yes', { source: 'user' }));
      assert(done.result?.isError, `it fails: ${JSON.stringify(done.result)}`);
      assert(String(done.result?.content).includes("Couldn't resume the program"), `and says why: ${done.result?.content}`);
      const report = programChangeReport(displayOf(mt, id));
      assert(report.includes(`- edit: ${dir}/c.txt`), `the change before the stop is still reported: ${JSON.stringify(report)}`);
      assert((await readFileLoad({ path: log }).catch(() => null))?.exists !== true, 'nothing ran again');
      const content = await readFileLoad({ path: `${dir}/c.txt` });
      assert(String(content.content) === 'hello there\n', `the edit is not redone: ${content.content}`);
    });

    // The worker resets a parked item to "" when its thread's strategy changes.
    // The journal outlives that, so the replay re-decides the held call under
    // the new strategy.
    await test('a strategy switch re-decides the held call on replay', async () => {
      const log = `rc-switch-${Date.now()}.txt`;
      const command = heldCommand(log);
      const code = `await tools.bash({ command: ${JSON.stringify(command)} }); return "done";`;
      const { conversation, mt, item } = await setup(code, { strategy: 'default' });
      const id = item.toolUseId;
      await assertParks(conversation, mt, command);
      const parked = await runAsAction(conversation, mt, id);
      assert(parked.state === 'pending', `suspended first: ${parked.state}`);
      mt.strategy = { getApprovalPolicy: YoloStrategyType.prototype.getApprovalPolicy };
      const ymap = mt.getToolAction(id);
      const done = await runAsAction(conversation, mt, id, () => {
        ymap.set('state', '');
        for (const field of ['approvalResponse', 'approvalOptions', 'displayData', 'hooks']) ymap.delete(field);
      });
      assert(done.state === 'completed' && done.result?.content === 'done', `it runs under the new strategy: ${JSON.stringify(done.result)}`);
      const ran = await readFileLoad({ path: log });
      assert(String(ran.content) === 'x', `once: ${JSON.stringify(ran.content)}`);
    });

    // The user approves the call they were shown. A replay that makes another
    // call at that step — here a command built from Math.random — must not be
    // handed the approval: it diverges, and neither command runs.
    await test('an approval never passes to a different call made in the held one\'s place', async () => {
      const dir = `rc-transfer-${Date.now()}`;
      const log = `${dir}/log.txt`;
      const prefix = `sh -c 'printf x >> ${log}'; printf `;
      const code = `await tools.bash({ command: ${JSON.stringify(prefix)} + Math.random() }); return "ran";`;
      const { conversation, mt, item } = await setup(code, { strategy: 'default' });
      const id = item.toolUseId;
      await assertParks(conversation, mt, `${prefix}0.5`);
      const parked = await runAsAction(conversation, mt, id);
      const shown = parked.suspendedCall?.input?.command;
      assert(parked.state === 'pending' && String(shown).startsWith(prefix), `suspended on the command: ${JSON.stringify(parked.suspendedCall)}`);
      const done = await runAsAction(conversation, mt, id, () => mt.resolveApproval(id, 'yes', { source: 'user' }));
      const text = String(done.result?.content);
      assert(done.result?.isError, `the replay must fail: ${JSON.stringify(done.result)}`);
      assert(text.includes("Couldn't resume the program") && text.includes('step 1') && text.includes(String(shown).slice(prefix.length)),
        `it says the call differed from the one approved: ${text}`);
      assert((await readFileLoad({ path: log }).catch(() => null))?.exists !== true, 'neither command ran');
      assert(rowsOf(mt, id).every((r) => r.status !== 'ok'), `no call ran: ${JSON.stringify(rowsOf(mt, id))}`);
      assert(!programJournals.has(item) && !done.suspendedCall, 'the program is over: no journal, no held call');
    });

    await test('a question suspends the program, and its answer is the call\'s result', async () => {
      const file = `rc-ask-${Date.now()}.txt`;
      const code = `
        await tools.bash({ command: "printf x >> ${file}" });
        const answer = await tools.AskUserQuestion({ questions: [{ question: "Which?", header: "Pick", multiSelect: false,
          options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }] });
        return "answer: " + String(answer).trim();`;
      // Under YOLO: a question always reaches the user.
      const { conversation, mt, item } = await setup(code);
      const id = item.toolUseId;
      const parked = await runAsAction(conversation, mt, id);
      assert(parked.state === 'pending', `a question suspends: ${parked.state} ${JSON.stringify(parked.result)}`);
      assert(parked.suspendedCall?.name === 'AskUserQuestion', `held: ${JSON.stringify(parked.suspendedCall)}`);
      const done = await runAsAction(conversation, mt, id, () => mt.resolveApproval(id, 'B', { source: 'user' }));
      assert(done.result?.content === 'answer: Pick: B', `the answer reaches the program: ${JSON.stringify(done.result)}`);
      const ran = await readFileLoad({ path: file });
      assert(String(ran.content) === 'x', `bash ran once: ${JSON.stringify(ran.content)}`);
    });

    // A suspension stops the program and cancels its running calls, and a
    // cancelled call is not journalled, so the replay runs it again. That is
    // safe only because nothing starts past a write still running — not even
    // a read, as a question is — so a call that suspends never cuts a write
    // off: the write has finished, and its answer is journalled, first.
    await test('a call fired beside a running write waits for it, so suspending never cuts it off', async () => {
      const file = `rc-alongside-${Date.now()}.txt`;
      const code = `
        const [, answer] = await Promise.all([
          tools.bash({ command: "printf start >> ${file}; sleep 1; printf end >> ${file}" }),
          tools.AskUserQuestion({ questions: [{ question: "Which?", header: "Pick", multiSelect: false,
            options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }] }),
        ]);
        return "answer: " + String(answer).trim();`;
      // Under YOLO the bash runs unasked and the question always reaches the user.
      const { conversation, mt, item } = await setup(code);
      const id = item.toolUseId;
      const parked = await runAsAction(conversation, mt, id);
      assert(parked.state === 'pending' && parked.suspendedCall?.name === 'AskUserQuestion',
        `the question suspends: ${parked.state} ${JSON.stringify(parked.suspendedCall)} ${JSON.stringify(parked.result)}`);
      const stopped = await readFileLoad({ path: file });
      assert(String(stopped.content) === 'startend', `the write finished before the program stopped: ${JSON.stringify(stopped.content)}`);
      const before = rowsOf(mt, id).map((r) => `${r.name}:${r.status}`).join(',');
      assert(before === 'bash:ok', `its row is kept as it ended: ${before}`);
      const done = await runAsAction(conversation, mt, id, () => mt.resolveApproval(id, 'B', { source: 'user' }));
      assert(done.result?.content === 'answer: Pick: B', `the program finishes: ${JSON.stringify(done.result)}`);
      const ran = await readFileLoad({ path: file });
      assert(String(ran.content) === 'startend', `the write ran once: ${JSON.stringify(ran.content)}`);
      const report = programChangeReport(displayOf(mt, id));
      assert((report.match(/- bash: /g) || []).length === 1, `it is reported once: ${JSON.stringify(report)}`);
    });

    // Only an import() the program makes is routed through the sandbox's
    // resolver: text that merely says "import(" — code a program writes — is
    // the program's data, and must reach the tool as written.
    await test('"import(" inside a string is data, not an import', async () => {
      const file = `rc-import-text-${Date.now()}.js`;
      const text = 'const m = await import("./x.js"); /* import( */ `${1}import (y)`';
      const code = `
        await tools.write({ file_path: "${file}", content: ${JSON.stringify(text)} });
        return ${JSON.stringify(text)} + "|" + 'import(' + "|" + \`import(\`;`;
      const { item } = await setup(code);
      const { out, text: got } = await run(item, code);
      assert(out?.success !== false, `must succeed, got: ${got}`);
      assert(got === `${text}|import(|import(`, `the strings are returned as written, got: ${got}`);
      const written = await readFileLoad({ path: file });
      assert(String(written.content) === text, `the file holds what the program wrote: ${written.content}`);
    });

    // A read through a tool is a read: the program saw the bytes in its result,
    // as it would through `fs`.
    await test('tools.read and tools.batch_read let the program edit what they read', async () => {
      const dir = `rc-toolread-${Date.now()}`;
      await writeFileOp({ path: `${dir}/a.txt`, content: 'hello world\n' });
      await writeFileOp({ path: `${dir}/b.txt`, content: 'hello world\n' });
      const code = `
        await tools.read({ file_path: "${dir}/a.txt" });
        await tools.edit({ file_path: "${dir}/a.txt", old_string: "world", new_string: "there" });
        await tools.batch_read({ files: [{ file_path: "${dir}/b.txt" }] });
        await tools.edit({ file_path: "${dir}/b.txt", old_string: "world", new_string: "there" });
        return "edited";`;
      const { item } = await setup(code);
      const { out, text } = await run(item, code);
      assert(out?.success !== false && text === 'edited', `both edits must be admitted, got: ${text}`);
      for (const f of ['a.txt', 'b.txt']) {
        const after = await readFileLoad({ path: `${dir}/${f}` });
        assert(String(after.content) === 'hello there\n', `${f} must be edited: ${after.content}`);
      }
    });

    // A strategy with a reviewer is handed a parked call before the user is;
    // a call held inside a program is no different.
    await test('a suspended call is offered to the strategy\'s reviewer', async () => {
      const log = `rc-review-${Date.now()}.txt`;
      const command = heldCommand(log);
      const code = `await tools.bash({ command: ${JSON.stringify(command)} }); return "done";`;
      const { conversation, mt, item } = await setup(code, { strategy: 'default' });
      const id = item.toolUseId;
      /** @type {any[]} */
      const offered = [];
      /** @type {(v: any) => void} */
      let finishReview = () => {};
      // The default policy (each tool's own rule), with a reviewer.
      mt.strategy = {
        onToolPending: (/** @type {any} */ call) => {
          offered.push(call);
          return new Promise((resolve) => { finishReview = resolve; });
        }
      };
      await assertParks(conversation, mt, command);
      const parked = await runAsAction(conversation, mt, id);
      assert(parked.state === 'pending', `suspended: ${parked.state}`);
      assert(offered.length === 1, `the reviewer is offered the held call once, got ${offered.length}`);
      const call = offered[0];
      assert(call.toolUseId === id, `under the program's id, which is what it resolves: ${call.toolUseId}`);
      assert(call.toolName === 'bash' && call.toolInput?.command === command, `as the held call: ${JSON.stringify(call)}`);
      assert(call.category === 'write' && call.autoApprovable === true, `with its category and autoApprovable: ${JSON.stringify(call)}`);
      assert(parked.reviewStatus?.busy === true, `parked already under review, so no alert fires yet: ${JSON.stringify(parked.reviewStatus)}`);
      finishReview({ note: 'declined: writes outside the project' });
      await waitUntil(() => mt.getToolAction(id)?.toJSON().reviewStatus?.busy === false, 'the review to close');
      assert(mt.getToolAction(id).toJSON().reviewStatus.label === 'declined: writes outside the project', 'its note stays in the card');
      const done = await runAsAction(conversation, mt, id, () => mt.resolveApproval(id, 'yes', { source: 'user' }));
      assert(done.state === 'completed' && done.result?.content === 'done', `approving finishes it: ${JSON.stringify(done.result)}`);
    });

    // A program's result is text; an image reaches the model only as an
    // attachment on it. A call that produced images gives the program handles,
    // and image() is how it attaches one.
    await test('tools.read on an image gives a handle, and image() attaches it', async () => {
      const dir = `rc-image-${Date.now()}`;
      await writeFileOp({ path: `${dir}/shot.png`, content: 'not really a png' });
      const code = `
        const r = await tools.read({ file_path: "${dir}/shot.png" });
        await image(r.images[0]);
        return { text: r.text, handle: r.images[0] };`;
      const { mt, item } = await setup(code);
      const { out, text, summary } = await run(item, code);
      assert(out?.success !== false, `must succeed, got: ${text}`);
      const attached = /** @type {any[]} */ (out.attachments || []);
      assert(attached.length === 1 && /^[0-9a-f]{64}$/.test(attached[0].id) && attached[0].mime === 'image/png',
        `the result carries the image: ${JSON.stringify(out.attachments)}`);
      const value = /** @type {any} */ (out).result;
      assert(value.handle?.image === attached[0].id && value.handle.label === `${dir}/shot.png`,
        `the handle names the image and where it came from: ${JSON.stringify(value.handle)}`);
      assert(String(value.text).includes('shot.png'), `the call's text comes with it: ${value.text}`);
      assert(Array.isArray(summary.attachments) && summary.attachments[0]?.id === attached[0].id,
        `the summary attaches it for the model: ${JSON.stringify(summary.attachments)}`);
      assert(text.includes(`Images attached below:\n- ${dir}/shot.png`), `the text says what is attached:\n${text}`);
      assert(JSON.stringify(heldOf(mt, item.toolUseId)) === JSON.stringify([attached[0].id]),
        `the item holds only what it attached once it ends: ${JSON.stringify(heldOf(mt, item.toolUseId))}`);
    });

    await test('image(path) attaches what fs found; anything else is refused', async () => {
      const dir = `rc-image-path-${Date.now()}`;
      await writeFileOp({ path: `${dir}/found.png`, content: 'also not a png' });
      await writeFileOp({ path: `${dir}/notes.txt`, content: 'text\n' });
      const code = `
        const [found] = await glob("*.png", { cwd: "${dir}" });
        await image("${dir}/" + found);
        const errs = {};
        try { await image("${dir}/notes.txt"); } catch (e) { errs.text = e.message; }
        try { await image({ image: "${'f'.repeat(64)}", mime: "image/png", bytes: 1 }); } catch (e) { errs.forged = e.message; }
        try { await fs.readFile("${dir}/found.png"); } catch (e) { errs.read = e.message; }
        return errs;`;
      const { item } = await setup(code);
      const { out, text } = await run(item, code);
      assert(out?.success !== false, `must succeed, got: ${text}`);
      assert(/** @type {any[]} */ (out.attachments || []).length === 1, `one image attached: ${JSON.stringify(out.attachments)}`);
      const errs = /** @type {any} */ (out).result;
      assert(String(errs.text).includes('is not an image'), `a text file is refused: ${errs.text}`);
      assert(String(errs.forged).includes("Couldn't attach that image"), `a handle it was never given is refused: ${errs.forged}`);
      assert(String(errs.read).includes('is an image') && String(errs.read).includes('image('),
        `fs.readFile on an image says so, and points at image(): ${errs.read}`);
    });

    await test('an image held across a suspension is attached once approved', async () => {
      const dir = `rc-image-held-${Date.now()}`;
      await writeFileOp({ path: `${dir}/shot.png`, content: 'held png' });
      const log = `${dir}/log.txt`;
      const command = heldCommand(log);
      const code = `
        const r = await tools.read({ file_path: "${dir}/shot.png" });
        await tools.bash({ command: ${JSON.stringify(command)} });
        await image(r.images[0]);
        return "shown";`;
      const { conversation, mt, item } = await setup(code, { strategy: 'default' });
      const id = item.toolUseId;
      await assertParks(conversation, mt, command);
      const parked = await runAsAction(conversation, mt, id);
      assert(parked.state === 'pending', `suspended first: ${parked.state}`);
      const held = heldOf(mt, id);
      assert(held.length === 1 && /^[0-9a-f]{64}$/.test(held[0]), `while it waits, the item holds the image: ${JSON.stringify(held)}`);
      const done = await runAsAction(conversation, mt, id, () => mt.resolveApproval(id, 'yes', { source: 'user' }));
      assert(done.state === 'completed' && done.result?.content?.startsWith('shown'), `it finishes: ${JSON.stringify(done.result)}`);
      const attachments = mt.getToolAction(id).get('attachments');
      const refs = attachments?.toJSON ? attachments.toJSON() : attachments;
      assert(Array.isArray(refs) && refs.length === 1 && refs[0].id === held[0],
        `the image from before the stop is attached: ${JSON.stringify(refs)}`);
    });

    // image(path) reads a file, so it is journalled like fs: the replay
    // attaches what the program saw before the stop, not what the file holds
    // by the time the user answers.
    await test('image(path) before a suspension is replayed, not read again', async () => {
      const dir = `rc-image-replay-${Date.now()}`;
      await writeFileOp({ path: `${dir}/shot.png`, content: 'before the stop' });
      const log = `${dir}/log.txt`;
      const command = heldCommand(log);
      const code = `
        await image("${dir}/shot.png");
        await tools.bash({ command: ${JSON.stringify(command)} });
        return "shown";`;
      const { conversation, mt, item } = await setup(code, { strategy: 'default' });
      const id = item.toolUseId;
      await assertParks(conversation, mt, command);
      const parked = await runAsAction(conversation, mt, id);
      assert(parked.state === 'pending', `suspended first: ${parked.state}`);
      const held = heldOf(mt, id);
      assert(held.length === 1, `while it waits, the item holds the image: ${JSON.stringify(held)}`);
      await writeFileOp({ path: `${dir}/shot.png`, content: 'changed while it waited' });
      const done = await runAsAction(conversation, mt, id, () => mt.resolveApproval(id, 'yes', { source: 'user' }));
      assert(done.state === 'completed', `it finishes: ${JSON.stringify(done.result)}`);
      const attachments = mt.getToolAction(id).get('attachments');
      const refs = attachments?.toJSON ? attachments.toJSON() : attachments;
      assert(Array.isArray(refs) && refs.length === 1 && refs[0].id === held[0],
        `the image the program saw is attached, not the file as it is now: ${JSON.stringify(refs)} vs ${JSON.stringify(held)}`);
    });

    await test('query_code attaches an image by path', async () => {
      const dir = `qc-image-${Date.now()}`;
      await writeFileOp({ path: `${dir}/chart.png`, content: 'a chart' });
      const code = `await image("${dir}/chart.png"); return "see it";`;
      const { conversation, mt } = await setup(code);
      const qc = new QueryCodeContextItem({ id: QueryCodeContextItem.MANIFEST.id, session, conversation, messageThread: mt });
      const out = await qc.execute({ code });
      const summary = qc.getSummary({ success: true, result: out });
      assert(/** @type {any[]} */ (out.attachments || []).length === 1, `the result carries the image: ${JSON.stringify(out)}`);
      assert(summary.attachments?.length === 1 && String(summary.summary).includes(`${dir}/chart.png`),
        `and the model is told and shown: ${JSON.stringify(summary)}`);
    });

    // The model's cut of a tool's output is sized for the model's context. A
    // program reads the output to work on it, and only what it returns
    // reaches the model, so it is handed the whole of it: 15000 lines is
    // ~79KB, past the model's budget here and inside the shell's own cap.
    // Past that cap the shell keeps a head and a tail and says where the rest
    // went, and a program sees that as plainly as the model would.
    await test('a tool call hands a program its whole output, not the model\'s cut of it', async () => {
      const code = `
        const out = await tools.bash({ command: "seq 1 15000" });
        const lines = out.split("\\n").filter((l) => /^\\d+$/.test(l));
        const huge = await tools.bash({ command: "seq 1 60000" });
        return { lines: lines.length, last: lines.at(-1), cut: /truncated/i.test(out), saved: huge.includes("FULL output saved to") };`;
      const { item } = await setup(code);
      const { out } = await run(item, code);
      const result = /** @type {any} */ (out)?.result;
      assert(result?.lines === 15000 && result.last === '15000' && result.cut === false,
        `the program must see every line: ${JSON.stringify(out)}`);
      assert(result.saved === true, `past the shell's cap, the program is told where the rest is: ${JSON.stringify(out)}`);
    });

    await test('writes fired together keep the program\'s order', async () => {
      const file = `rc-order-${Date.now()}.txt`;
      const code = `
        await Promise.all([1, 2, 3].map((n) =>
          tools.bash({ command: "sleep 0.$((4 - " + n + ")); echo " + n + " >> ${file}" })));
        return "ok";`;
      const { item } = await setup(code);
      const { text } = await run(item, code);
      assert(text.startsWith('ok'), `got: ${text}`);
      const content = await readFileLoad({ path: file });
      assert(String(content.content) === '1\n2\n3\n', `writes ran out of order: ${JSON.stringify(content.content)}`);
    });
  } finally {
    /** @type {any} */ (globalThis).JUGGLER_ENGINE = prevEngine;
  }

  return { passed, failed, errors };
}
