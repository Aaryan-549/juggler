//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import { runInSandbox } from 'juggler/sandbox';
import { MAX_EXEC_TIMEOUT_MS } from 'juggler/ops';
import { itemClassForTool } from 'juggler/registry';
import QueryCodeContextItem, { summaryWithImages } from './query-code-context-item.js';
import { beginProgramReads } from './read-history.js';
import { renderProgramSdk, describeProgramTool, toolOwnName } from './code/render-sdk.js';
import { journalCapabilities } from './code/program-journal.js';
import { pointImageReadsAtImage } from './code/program-images.js';
import { extractErrorMessage } from '../../../sdk/lib/error-utils.js';

/**
 * A program's state between passes: its journal (program-journal.js) and the
 * call record of the passes it replays, whose calls never reach this pass's
 * invoker, and the images it had been given (code/program-images.js), whose
 * handles its journal replays. `ended` answers whether its item has ended
 * some other way (a denial settles it without running it again).
 * @typedef {{journal: Array<import('./code/program-journal.js').JournalEntry|undefined>, record: {calls: Array<Record<string, unknown>>, omitted: number, omittedEffects: number}, images?: Map<string, any>, ended?: () => boolean}} SavedProgram
 */

/** @typedef {{toolUseId?: string|null, id: string, conversation?: any, messageThread?: any}} ProgramRef */

/**
 * Suspended programs' saved state, held in engine memory while each waits on
 * the user: by conversation, then by thread and tool-use id (a tool-use id is
 * unique only within a conversation). Held weakly by the conversation, so a
 * conversation the engine lets go of takes its programs' journals — their
 * file contents, tool output and images — with it.
 * @type {WeakMap<object, Map<string, SavedProgram>>}
 */
const savedByConversation = new WeakMap();

/** Where an item with no conversation keeps its journal. */
const NO_CONVERSATION = {};

/**
 * The saved programs of an item's conversation.
 * @param {ProgramRef} item - A run_code item
 * @param {boolean} [create] - Make the map when there is none
 * @returns {Map<string, SavedProgram>|undefined} Its conversation's saved programs
 */
function savedIn(item, create = false) {
  const owner = item.conversation ?? NO_CONVERSATION;
  let saved = savedByConversation.get(owner);
  if (!saved && create) {
    saved = new Map();
    savedByConversation.set(owner, saved);
  }
  return saved;
}

/**
 * An item's key within its conversation's saved programs.
 * @param {ProgramRef} item - A run_code item
 * @returns {string} The key
 */
function programKey(item) {
  return JSON.stringify([item.messageThread?.threadItemId ?? '', item.toolUseId || item.id]);
}

/**
 * Suspended programs' saved state, by the run_code item a program is.
 */
export const programJournals = {
  /**
   * @param {ProgramRef} item - The program
   * @returns {SavedProgram|undefined} Its saved state
   */
  get: (item) => savedIn(item)?.get(programKey(item)),
  /**
   * @param {ProgramRef} item - The program
   * @param {SavedProgram} saved - Its state, to keep
   */
  set: (item, saved) => {
    savedIn(item, true)?.set(programKey(item), saved);
  },
  /**
   * @param {ProgramRef} item - The program
   * @returns {boolean} Whether it has saved state
   */
  has: (item) => !!savedIn(item)?.has(programKey(item)),
  /**
   * @param {ProgramRef} item - The program
   */
  delete: (item) => {
    savedIn(item)?.delete(programKey(item));
  },
};

/**
 * Drop the journals of this conversation's programs whose items have ended
 * without them.
 * @param {ProgramRef} item - A run_code item of the conversation
 */
function pruneEndedJournals(item) {
  const saved = savedIn(item);
  if (!saved) return;
  for (const [key, program] of saved) {
    if (program.ended?.()) saved.delete(key);
  }
}

/** How often the live call rows are written while a program runs. */
const ROWS_WRITE_INTERVAL_MS = 250;

/**
 * RunCodeContextItem - Run a JavaScript program that calls tools.
 *
 * query_code's sandbox and read-only surface (`fs`, `grep`, `glob`, `path`,
 * `projectRoot`, `import()`), plus `tools.*`: the conversation's own tools,
 * each call admitted against what the thread was offered and put to the same
 * approval decision as the model's own call (ContextItem#createToolInvoker).
 * Only what the program returns enters context, followed by the list of changes
 * its calls made — reads are never listed, changes always are. That list is not
 * this item's to write: the worker's projection builds it from the call record
 * kept on the item (`displayData.nestedCalls`), so it reaches the model however
 * the program ended, a cancel included.
 *
 * A call the decision would park suspends the program: this item goes back to
 * the user with that call's own approval, and once they answer it is run again
 * from the top, every earlier call answered from the program's journal
 * (`programJournals`) and the held call handed over as approved. A denial
 * cancels the item as any denial does.
 * @class
 * @augments QueryCodeContextItem
 */
class RunCodeContextItem extends QueryCodeContextItem {
  static MANIFEST = {
    // Persisted in users' plugin lists, and the key the system-prompt section
    // gates on. Never change it.
    id: 'run-code',
    name: 'Run Code',
    version: '1.0.0',
    description: 'Run a JavaScript program that calls tools, so only its result enters context',
    author: 'Juggler Team',
    requiresApproval: false,
    // No program calls a program.
    composable: false
  };

  /**
   * A program's time includes its tool calls, so it may run as long as one
   * bash call may: no shorter, or it would cut short a command it was allowed
   * to run.
   */
  static MAX_TIMEOUT_MS = MAX_EXEC_TIMEOUT_MS;

  /**
   * @returns {Array<{name: string, category: string, description: string, input_schema: import('juggler/strategy-type').JSONObjectSchema, programSdk: boolean}>} Tool definitions
   */
  static getToolDefinitions() {
    return [{
      name: 'run_code',
      category: 'write',
      // Followed by the rule for calling the thread's tools from a program
      // (render-sdk.js, attached by thread-tool-inventory.js). Every request
      // carries this text: what the model's tool list already says, and what
      // the code parameter says, is not said again.
      programSdk: true,
      description: 'Run a JavaScript program that calls tools; only what it returns enters the conversation, '
        + 'plus a list of what it changed. Use it for work that loops, branches or aggregates over many tool calls. '
        + 'Each call is approved as if you made it directly, and a denial ends the program. One that waits for the '
        + 'user\'s approval pauses it; it then reruns from the top with earlier calls answered as before, so make '
        + 'the same calls.',
      input_schema: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description: 'JavaScript (async/await OK; return a value). Browser realm, not Node. In scope: '
              + '`fs` (read-only fs.promises subset), `path` (POSIX), `grep(pattern, {cwd?, glob?, maxResults?, ignoreCase?})`, '
              + '`glob(pattern, {cwd?})`, `projectRoot`, `tools`, `describeTool`, `image(handleOrPath)`; `import()` modules under projectRoot. '
              + 'A call that produced images returns `{text, images}`; `await image(images[0])` attaches one to your result.'
          },
          description: {
            type: 'string',
            description: 'Short user-facing description of what this program does.'
          },
          timeout: {
            type: 'number',
            description: `Optional execution timeout in milliseconds (1000–${MAX_EXEC_TIMEOUT_MS}, default 120000). It includes time spent in tool calls.`
          }
        },
        required: ['code']
      }
    }];
  }

  /**
   * The SDK text appended to run_code's description for the tools a program
   * may call in this thread (thread-tool-inventory.js).
   * @param {Array<Record<string, any>>} callable - The callable offered tools
   * @param {Array<Record<string, any>>} [excluded] - The offered tools a program may not call
   * @returns {string} The SDK text
   */
  static renderProgramSdk(callable, excluded = []) {
    return renderProgramSdk(/** @type {any} */ (callable), /** @type {any} */ (excluded));
  }

  /**
   * Run the program.
   *
   * Returns the program's value with its console output and the files it read
   * (`filesRead`, for read credit). A program that throws, times out, or is
   * refused a call returns a structured failure carrying the same. A cancel
   * stays a bare AbortError, like query_code's. What the program changed is in
   * the call record on the item, whichever way it ended.
   * @param {Record<string, unknown>} params - Validated params
   * @returns {Promise<Record<string, unknown>>} Program result
   */
  async execute(params) {
    const code = /** @type {string} */ (params.code);
    const timeoutMs = params.timeout ? Number(params.timeout) : 120000;

    const workspaceRoot = this.getWorkspaceRoot();
    if (workspaceRoot === null) {
      throw new Error(
        'Couldn\'t run: this conversation\'s workspace is unavailable — it is still being '
        + 'created, was closed, or its directory has gone.');
    }

    const fs = this.ops.readOnlyFileSystem();
    // A program that writes through `fs` means to change a file, and here there
    // is a way to: say so, or the model retries the write and gives up on
    // run_code. The refusal itself is ReadOnlyFileSystem's.
    const refuseWrite = async () => {
      throw new Error('EROFS: read-only filesystem. In run_code, fs only reads: change files with tools.write or tools.edit.');
    };
    Object.assign(fs, { writeFile: refuseWrite, mkdir: refuseWrite });
    pointImageReadsAtImage(fs);
    const { grep, glob } = this._createSearchHelpers();

    const programId = this.toolUseId || this.id;
    pruneEndedJournals(this);
    const toolAction = this._toolAction();
    const plainOf = (/** @type {any} */ v) => (v?.toJSON ? v.toJSON() : v);
    /** @type {{name: string, input: Record<string, unknown>}|undefined} */
    const held = plainOf(toolAction?.get('suspendedCall')) || undefined;
    const saved = programJournals.get(this);
    if (held && !saved) {
      // Suspended, and the journal went with the engine that kept it (a
      // restart). Running it again would redo what it did before the stop;
      // the worker still reports those changes from the rows on the item.
      this._clearSuspendedCall();
      this._holdAssets([]);
      return {
        success: false,
        errorCode: 'program-failed',
        error: `Couldn't resume the program: it was waiting for approval to run ${held.name} when Juggler `
          + 'restarted, and what it had done so far was lost. Nothing ran again.'
      };
    }
    // The answer to the call it was suspended on. A strategy switch clears it,
    // and the replay then puts that call to the decision again.
    const answer = held ? toolAction?.get('approvalResponse') : undefined;

    // The program stops on a cancel (this item's signal), a refused call, or a
    // call that waits on the user. One controller covers all three, so the
    // sandbox and every running call end the same way whichever it was.
    const controller = new AbortController();
    const onCancel = () => controller.abort();
    this.signal?.addEventListener('abort', onCancel, { once: true });
    /** @type {Error|null} */
    let refusal = null;
    /** @type {Record<string, unknown>|null} */
    let suspension = null;
    const invoker = this.createToolInvoker({
      signal: controller.signal,
      onRefused: (err) => {
        refusal = err;
        controller.abort();
      },
      onSuspended: (err) => {
        suspension = err.suspension;
        controller.abort();
      }
    });

    // A program run again after a stop replays the passes before it: their
    // calls are answered from the journal, and their rows come first.
    const journal = saved?.journal ?? [];
    if (saved) {
      invoker.record.calls.unshift(...saved.record.calls);
      invoker.record.omitted += saved.record.omitted;
      invoker.record.omittedEffects += saved.record.omittedEffects;
    }

    const rows = this._liveRows(invoker.record);
    // A namespace: any `tools.<name>` reaches the invoker, which refuses a name
    // the thread does not offer in the worker's own words.
    const tools = new Proxy({}, {
      get: (_target, name) => {
        if (typeof name !== 'string' || name === 'then') return undefined;
        return async (/** @type {Record<string, unknown>} */ args) => {
          const call = invoker.invoke(name, args, { withAttachments: true });
          rows.touch();
          try {
            // A call that produced images hands the program their handles
            // beside its text; the pixels stay in the asset store.
            const { content, attachments } = await call;
            if (!attachments.length) return content;
            const label = typeof args?.file_path === 'string' ? args.file_path
              : typeof args?.path === 'string' ? args.path : name;
            return { text: content, images: images.receive(attachments, label) };
          } finally {
            rows.touch();
          }
        };
      }
    });

    // The SDK in run_code's description is an index; this is the rest of it.
    // Over the invoker's own admitted set, so it can describe exactly the tools
    // a call would be admitted to, and never another.
    const describeTool = async (/** @type {unknown} */ name) => {
      const offered = await invoker.offered();
      if (name === undefined) return [...offered.keys()];
      const def = offered.get(String(name)) ?? offered.get(toolOwnName(String(name)));
      if (!def) {
        throw new Error(`Couldn't describe ${String(name)}: it can't be called from a program in this thread. `
          + 'describeTool() lists the ones that can.');
      }
      return describeProgramTool(/** @type {any} */ (def));
    };

    const endReads = beginProgramReads(this.conversation, programId, fs.filesRead);
    // Every capability call is journalled; one that diverges from the journal
    // ends the program as a refusal does, uncatchable. `image` here is only
    // image(path)'s read of the file, journalled like any read so a replay
    // attaches what the program saw; the attaching is done on every pass.
    const journalled = journalCapabilities({ fs, grep, glob, tools, image: this._imagePathLoader() }, {
      journal,
      ledger: fs.filesRead,
      onDiverge: (err) => {
        if (!refusal) refusal = err;
        controller.abort();
      },
      // The step the program was suspended on, reached again: the user's
      // answer is that call's approval.
      onHeld: (entry) => {
        if (held && typeof answer === 'string' && entry.key === `tools.${held.name}`) {
          invoker.approveNext(held.name, held.input ?? {}, answer);
        }
      }
    });
    const { image: loadImage, ...capabilities } = journalled;
    const images = this._programImages(saved?.images, loadImage);

    /** @type {string[]} */
    const consoleLines = [];
    let value;
    /** @type {unknown} */
    let failure = null;
    try {
      value = await runInSandbox(code, {
        capabilities: { ...capabilities, describeTool, image: images.show },
        timeoutMs,
        projectRoot: workspaceRoot,
        signal: controller.signal,
        onConsole: (line) => { consoleLines.push(line); },
      });
    } catch (err) {
      failure = err;
      // A replay waiting on a call the program never made again runs out its
      // time doing nothing: say which call, not just that time ran out.
      const stalledOn = journalled.stalledOn();
      if (stalledOn && !refusal && /timed out after/.test(extractErrorMessage(err))) {
        refusal = new Error(`Couldn't resume the program: last time it called ${stalledOn} at this point, `
          + 'and this time it never did, so it waited until it timed out. A program resumes by making the same '
          + 'calls as before; make them in an order that does not depend on timing.');
      }
    } finally {
      this.signal?.removeEventListener('abort', onCancel);
      endReads();
      const suspended = suspension && !this.signal?.aborted;
      if (suspended) {
        // What carries over is what answered: the rows the journal will
        // replay. Every other call this pass made is made again.
        const kept = invoker.record.calls.filter((c) => c.status === 'ok' || c.status === 'error');
        invoker.record.calls.splice(0, invoker.record.calls.length, ...kept);
        programJournals.set(this, {
          journal,
          record: {
            calls: kept.map((c) => ({ ...c })),
            omitted: invoker.record.omitted,
            omittedEffects: invoker.record.omittedEffects
          },
          images: images.received,
          ended: () => this._hasEnded()
        });
      } else {
        programJournals.delete(this);
        if (held) this._clearSuspendedCall();
      }
      rows.flush();
    }

    if (failure && this.signal?.aborted) {
      this._holdAssets([]);
      throw failure;
    }
    // The engine writes the item back to pending with this call's approval.
    if (suspension) return { suspended: suspension };

    /** @type {Record<string, unknown>} */
    const out = failure
      ? {
        success: false,
        errorCode: 'program-failed',
        error: /** @type {Error|null} */ (refusal)?.message
          ?? (failure instanceof Error ? failure.message : String(failure))
      }
      : { result: value === undefined ? null : value };
    if (consoleLines.length > 0) out.console = consoleLines;
    if (failure) this._holdAssets([]);
    else this._attachShown(out, images);
    if (fs.filesRead.size > 0) {
      /** @type {Record<string, string|null>} */
      const filesRead = {};
      for (const [p, hash] of fs.filesRead) filesRead[p] = hash;
      out.filesRead = filesRead;
    }
    return out;
  }

  /**
   * This program's tool-action, if it is in the thread.
   * @returns {any} The tool-action's map, or undefined
   * @private
   */
  _toolAction() {
    return this.toolUseId ? this.messageThread?.getToolAction?.(this.toolUseId) : undefined;
  }

  /**
   * Whether this program's item has settled (completed or cancelled), so its
   * journal can never be replayed. An item this thread cannot find is not
   * known to have ended, so its journal is kept.
   * @returns {boolean} True once settled
   * @private
   */
  _hasEnded() {
    const state = this._toolAction()?.get('state');
    return state === 'completed' || state === 'cancelled';
  }

  /**
   * Forget the call the program was suspended on, once a pass has ended it.
   * @private
   */
  _clearSuspendedCall() {
    const toolAction = this._toolAction();
    if (!toolAction?.has('suspendedCall')) return;
    this.messageThread?.transact(() => toolAction.delete('suspendedCall'));
  }

  /**
   * Keep the program's call record on its item as `displayData` —
   * `{nestedCalls, omitted, omittedEffects}` — so the user watches the calls
   * happen, and so the worker can tell the model what the program changed
   * however it ended (a cancel leaves no result of the engine's to carry it).
   * Writes are throttled. `flush` writes the final state and closes the writer:
   * a call still unwinding after the program has ended must not rewrite a
   * record the worker may already have sent.
   * @param {{calls: Array<Record<string, unknown>>, omitted: number, omittedEffects: number}} record - The invoker's record
   * @returns {{touch: () => void, flush: () => void}} The writer
   * @private
   */
  _liveRows(record) {
    /** @type {ReturnType<typeof setTimeout>|null} */
    let timer = null;
    let closed = false;
    const write = () => {
      timer = null;
      const thread = this.messageThread;
      if (!thread || !this.toolUseId) return;
      const items = thread.items;
      for (let i = 0; i < items.length; i++) {
        if (items[i].get('toolUseId') === this.toolUseId) {
          thread.updateItemField(i, 'displayData', {
            nestedCalls: record.calls.map((c) => ({ ...c })),
            omitted: record.omitted,
            omittedEffects: record.omittedEffects
          });
          return;
        }
      }
    };
    return {
      touch: () => {
        if (!closed && !timer) timer = setTimeout(write, ROWS_WRITE_INTERVAL_MS);
      },
      flush: () => {
        if (closed) return;
        closed = true;
        if (timer) clearTimeout(timer);
        write();
      }
    };
  }

  /**
   * Format the result for the LLM: the program's value (or its error), then its
   * console output. The changes the program made follow it on the wire, added
   * by the worker from the call record, so they are never truncated away with
   * the value and are there even when the program never got this far.
   * @param {import('juggler/context-item').Outcome} outcome - Action outcome
   * @returns {import('juggler/context-item').ItemSummary} Formatted result
   */
  getSummary(outcome) {
    const result = /** @type {Record<string, any>} */ (outcome.result || {});
    const consoleLines = Array.isArray(result.console) ? result.console : [];

    if (!outcome.success) {
      return this.failureSummary(withConsole(outcome.error || 'run_code failed', consoleLines));
    }

    let content;
    if (result.result !== null && result.result !== undefined) {
      content = typeof result.result === 'string' ? result.result : JSON.stringify(result.result, null, 2);
    } else {
      content = '(no return value)';
    }
    return summaryWithImages(this, this.truncateForLLM(withConsole(content, consoleLines)), result);
  }

  /**
   * @override
   * @param {import('../../../js/services/action-executor.js').ActionStatus|null} actionStatus - Status
   * @param {Record<string, unknown>} toolInput - Original tool input
   * @param {{conversation?: any, messageThread?: any, session?: any, toolUseId?: string}} [context] - UI context
   * @returns {import('juggler/context-item').ResultStatusMessage|null} Status config
   */
  getStatusUI(actionStatus, toolInput, context) {
    // Suspended: the card asks about the held call, so it is drawn as that
    // call's own tool draws it — bash's command, an edit's file, a question's
    // form, which answers this item.
    const held = actionStatus?.pending ? this._heldCall(context) : null;
    if (held) {
      const ui = held.sub.getStatusUI(
        { ...actionStatus, actionId: held.sub.id, displayData: held.call.displayData },
        held.call.input,
        context
      );
      if (ui) return { ...ui, typeName: `Program · ${ui.typeName || held.call.name}` };
    }
    const ui = super.getStatusUI(actionStatus, toolInput);
    return ui ? { ...ui, typeName: 'Program' } : ui;
  }

  /**
   * The call this program is suspended on, with an instance of its tool's
   * class to draw it, while the item waits on the user for it.
   * @param {{toolAction?: any, messageThread?: any, conversation?: any, session?: any, toolUseId?: string}} [context] - UI context
   * @returns {{sub: any, call: {name: string, input: Record<string, unknown>, displayData?: unknown}}|null} The held call, or null
   * @private
   */
  _heldCall(context) {
    const thread = context?.messageThread ?? this.messageThread;
    const toolAction = context?.toolAction
      ?? (context?.toolUseId ? thread?.getToolAction?.(context.toolUseId) : undefined);
    if (!toolAction || toolAction.get('state') !== 'pending') return null;
    const plainOf = (/** @type {any} */ v) => (v?.toJSON ? v.toJSON() : v);
    const options = plainOf(toolAction.get('approvalOptions'));
    const call = plainOf(toolAction.get('suspendedCall'));
    if (!options?.suspended || typeof call?.name !== 'string') return null;
    const SubClass = /** @type {any} */ (itemClassForTool(call.name));
    if (!SubClass) return null;
    const conversation = context?.conversation ?? this.conversation;
    const sub = new SubClass({
      id: SubClass.MANIFEST?.id || call.name,
      session: context?.session ?? conversation?.session ?? this.session,
      conversation,
      messageThread: thread,
      toolName: call.name
    });
    return { sub, call: { ...call, input: call.input || {} } };
  }

  /**
   * @override
   * @param {HTMLElement} wrapper
   * @param {import('juggler/context-item').ToolActionRenderContext} ctx
   * @returns {{ skipResultSection?: boolean } | void} Render result
   */
  renderToolActionDetails(wrapper, ctx) {
    const held = this._heldCall(ctx);
    if (held) {
      // The held call first, as its own tool shows it (an edit's diff, bash's
      // command), read from the call rather than from this item.
      const { call } = held;
      const fields = /** @type {Record<string, unknown>} */ ({
        toolName: call.name, toolInput: call.input, displayData: call.displayData, result: undefined
      });
      const toolAction = {
        get: (/** @type {string} */ key) => (key in fields ? fields[key] : ctx.toolAction?.get?.(key)),
        has: (/** @type {string} */ key) => (key in fields ? fields[key] !== undefined : !!ctx.toolAction?.has?.(key)),
      };
      held.sub.renderToolActionDetails(wrapper, {
        ...ctx, toolAction, toolName: call.name.toLowerCase(), input: call.input
      });
      this._renderProgram(wrapper, ctx);
      return { skipResultSection: true };
    }
    this._renderProgram(wrapper, ctx);
  }

  /**
   * The program itself in the panel: its code and description, and a row per
   * call it has made.
   * @param {HTMLElement} wrapper
   * @param {import('juggler/context-item').ToolActionRenderContext} ctx
   * @private
   */
  _renderProgram(wrapper, ctx) {
    super.renderToolActionDetails(wrapper, ctx);
    const display = ctx.toolAction?.get?.('displayData');
    const data = display?.toJSON ? display.toJSON() : display;
    const calls = Array.isArray(data?.nestedCalls) ? data.nestedCalls : [];
    if (calls.length === 0) return;
    const lines = calls.map(callRow);
    if (data.omitted) lines.push(`…${data.omitted} more not shown`);
    ctx.helpers.addSubsection(wrapper, 'Tool calls', lines.join('\n'), 'properties-panel-text');
  }
}

/**
 * One row of the call list a user sees.
 * @param {Record<string, any>} c - A recorded call
 * @returns {string} The row
 */
function callRow(c) {
  const mark = { ok: '✓', error: '✗', refused: '⊘', cancelled: '◼', running: '…', queued: '·', suspended: '⏸' }[/** @type {string} */ (c.status)] || '?';
  const args = c.effect ? String(c.effect).replace(/^[^:]*:\s*/, '') : briefArgs(c.args);
  const time = typeof c.durationMs === 'number' ? ` — ${c.durationMs}ms` : '';
  const error = c.error ? ` — ${c.error}` : '';
  return `${mark} ${c.name} ${args}${time}${error}`.replace(/\s+/g, ' ').trim();
}

/**
 * A call's arguments, in brief.
 * @param {unknown} args - Recorded arguments
 * @returns {string} One short line
 */
function briefArgs(args) {
  const text = JSON.stringify(args ?? {});
  return text.length > 120 ? text.slice(0, 119) + '…' : text;
}

/**
 * Append a program's console output to the text the model reads.
 * @param {string} text - The result or error text
 * @param {string[]} lines - Console lines, already capped by the sandbox
 * @returns {string} text, followed by the output when there is any
 */
function withConsole(text, lines) {
  return lines.length > 0 ? `${text}\n\nConsole output:\n${lines.join('\n')}` : text;
}

export default RunCodeContextItem;
