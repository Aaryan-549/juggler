//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The tool invoker: how a program tool's `tools.*` calls run.
 *
 * A sub-call is not a tool-action. Nothing is written to the transcript; the
 * engine runs the tool here, through the same execute path a tool-action takes
 * (`actionExecutor.execute`), and the program's own item keeps a bounded record
 * of what was called. Every call is first put to the real approval decision
 * (`decideToolCall`), so the user's rules, hooks and strategy rule on it as
 * they would on the model's own call:
 *   - "approve" runs it;
 *   - "park" suspends the program (`onSuspended`, with the call's own approval
 *     form): the pass ends, and the program's item waits on the user as a
 *     parked call does. Approving it runs the program again from the top,
 *     replaying what it did from its journal, and the held call is then
 *     handed over as approved (`approveNext`). Without `onSuspended` a park
 *     refuses, as a deny does;
 *   - "deny" (a hook said no) refuses, and the program ends;
 *   - "invalid" is an error the program may catch.
 *
 * The rules the invoker keeps:
 *   - Admission. A call to a tool the thread was not offered, or to one that
 *     stays native (it delegates, writes the thread, or is bookkeeping the model
 *     should do in the open), is refused before anything runs, in the worker's
 *     own words for a tool the model was not given.
 *   - Order. Calls keep the program's order the way a turn's calls do
 *     (cmd/juggler/worker/tool_ordering.go): reads overlap, and any other call
 *     waits for every earlier call and holds back every later one. The worker's
 *     gate sees only tool-actions, so it cannot do this for sub-calls.
 *   - A limit on calls in flight, so `Promise.all` over a list runs a few at a
 *     time instead of all at once.
 *   - Cancellation. When the program's signal aborts, every running call is
 *     cancelled through the executor and every queued call is refused.
 *   - The record: name, clipped args, status, duration, error and — for calls
 *     that change something — a one-line effect. Never a result: hiding results
 *     is the point. It is bounded, and gives up reads before effects, because
 *     the effects are what the model is always told.
 * @module services/tool-invoker
 */

import actionExecutor, { toolResultContent } from './action-executor.js';
import contextItemRegistry from '../registries/context-item-registry.js';
import { extractErrorMessage } from '../../sdk/lib/error-utils.js';
import { isComposableTool } from './composable-tools.js';
import { INTERACTION_KIND } from '../../sdk/context-item.js';

/** @typedef {import('./ops-api.js').AssetRef} AssetRef */

/** A tool ran and failed, or could not be run. A program may catch it. */
export class ToolError extends Error {
  /** @param {string} message - What went wrong */
  constructor(message) {
    super(message);
    this.name = 'ToolError';
  }
}

/**
 * The user's gate said no, or the program was interrupted. The program ends: it
 * may not catch a refusal and route around it with a variant of the call.
 */
export class ToolRefused extends Error {
  /** @param {string} message - Why the program was stopped */
  constructor(message) {
    super(message);
    this.name = 'ToolRefused';
  }
}

/**
 * What a suspended call needs to be put to the user: the program's item shows
 * it in its approval card, and its buttons are the sub-tool's own.
 * @typedef {object} Suspension
 * @property {string} name - The held tool
 * @property {Record<string, unknown>} input - Its arguments, as the program passed them
 * @property {string} reason - What it waits on, in the decision's words
 * @property {Record<string, any>} approvalOptions - Its approval form; every
 *   "don't ask again" button names the rule it saves for the sub-tool
 * @property {unknown} [displayData] - Its preview (an edit's diff)
 * @property {string} [note] - A line for the card, when a hook is holding it
 * @property {(import('../model/conversation-tool-actions.js').ReviewableCall & {label: string|null})|null} [review] -
 *   The call as the strategy's reviewer is handed it, when one may be
 *   (conversation-tool-actions.js reviewForSuspension); `label` marks the
 *   suspension as under review when the strategy has a reviewer
 */

/**
 * A call is waiting on the user, so the program stops here until they answer.
 * The program ends as a refusal ends it; the call is not refused.
 */
export class ToolSuspended extends Error {
  /**
   * @param {string} message - What it waits on
   * @param {Suspension} suspension - The call, as the user is asked about it
   */
  constructor(message, suspension) {
    super(message);
    this.name = 'ToolSuspended';
    this.suspension = suspension;
  }
}

/**
 * Keep the buttons of an approval form that are safe on a program's card: all
 * but a "don't ask again" that names nothing to save. The program's item is
 * what the user answers, so a bare one would save a grant for the program tool
 * (saveAutoApprovalPermission's fallback) rather than for the sub-tool.
 * @param {Array<Record<string, any>>} options - The sub-tool's buttons
 * @returns {Array<Record<string, any>>} Those that remain
 */
function keepNamedGrants(options) {
  return options.filter((o) => !(typeof o.value === 'string' && o.value.startsWith('yes-always'))
    || (o.rules && o.itemType)
    || (Array.isArray(o.allowedPaths) && o.allowedPaths.length > 0));
}

/** Calls running at once, by default. */
const DEFAULT_LIMIT = 4;
/** Calls kept in the record, by default. */
const DEFAULT_MAX_RECORDS = 200;
/** Longest string kept in a recorded argument. */
const MAX_ARG_CHARS = 500;
/** Longest effect line. */
const MAX_EFFECT_CHARS = 200;

/**
 * The offered tools a program may call, with each tool's class consulted.
 * @param {Array<Record<string, any>>} offered - The thread's offered tools
 * @returns {Array<Record<string, any>>} The composable subset, in the same order
 */
export function composableTools(offered) {
  return offered.filter((def) => isComposableTool(/** @type {any} */ (def), contextItemRegistry.getByToolName(def.name) || null));
}

/**
 * Clip a value for the record: strings to MAX_ARG_CHARS, nested values by the
 * same rule, so the record stays small whatever the program passed.
 * @param {unknown} value - An argument value
 * @param {number} [depth] - Nesting depth reached
 * @returns {unknown} The clipped copy
 */
function clipArg(value, depth = 0) {
  if (typeof value === 'string') {
    return value.length > MAX_ARG_CHARS ? value.slice(0, MAX_ARG_CHARS) + '…' : value;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 3) return '…';
  if (Array.isArray(value)) {
    const head = value.slice(0, 20).map((v) => clipArg(v, depth + 1));
    return value.length > 20 ? [...head, `…${value.length - 20} more`] : head;
  }
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = clipArg(v, depth + 1);
  return out;
}

/**
 * A call's arguments as a key that two spellings of the same arguments share:
 * JSON with every object's keys sorted, since arguments that went through the
 * document come back in whatever order it keeps them.
 * @param {unknown} value - Arguments
 * @returns {string} The key
 */
function argsIdentity(value) {
  /**
   * @param {unknown} v - A value
   * @returns {unknown} It, with every object's keys in sorted order
   */
  const sorted = (v) => {
    if (Array.isArray(v)) return v.map(sorted);
    if (v === null || typeof v !== 'object') return v;
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sorted(/** @type {Record<string, unknown>} */ (v)[k]);
    return out;
  };
  return JSON.stringify(sorted(value ?? {})) ?? '';
}

/**
 * The one-line effect of a call that changes something: the command it ran, or
 * the path it acted on, or failing both, its arguments in brief.
 * @param {string} name - Tool name
 * @param {Record<string, unknown>} args - Its arguments
 * @returns {string} The effect line
 */
function effectLine(name, args) {
  const pick = (/** @type {string[]} */ keys) => {
    for (const k of keys) {
      const v = args?.[k];
      if (typeof v === 'string' && v) return v;
    }
    return '';
  };
  const target = pick(['command', 'file_path', 'path', 'url', 'name']) || JSON.stringify(args ?? {});
  const line = `${name}: ${target.replace(/\s+/g, ' ').trim()}`;
  return line.length > MAX_EFFECT_CHARS ? line.slice(0, MAX_EFFECT_CHARS) + '…' : line;
}

/**
 * @typedef {object} NestedCall
 * @property {string} name - Tool name as the program called it
 * @property {unknown} args - Its arguments, clipped
 * @property {'queued'|'running'|'ok'|'error'|'refused'|'cancelled'|'suspended'} status - Where it got to
 * @property {number} [durationMs] - How long it ran
 * @property {string} [error] - Why it failed or was refused
 * @property {string} [effect] - What it changed, for a call that changes things
 */

/**
 * @typedef {object} NestedCallRecord
 * @property {NestedCall[]} calls - The calls kept, in the order they were made
 * @property {number} omitted - Calls dropped to stay within the bound
 * @property {number} omittedEffects - Of those, how many changed something
 */

/**
 * @typedef {object} InvokerDeps
 * @property {() => Promise<Array<Record<string, any>>>} offeredTools - The thread's composable offered tools
 * @property {(call: {toolName: string, toolInput: Record<string, unknown>, toolUseId: string}) => Promise<{verdict: string, reason: string}>} decide - The approval decision
 * @property {(call: {toolName: string, input: Record<string, unknown>, toolUseId: string}) => Promise<{success: boolean, cancelled?: boolean, content: string, error?: string, attachments?: AssetRef[]}>} run - Run the tool
 * @property {(toolUseId: string) => void} cancel - Cancel a running call
 * @property {(call: {name: string, args: Record<string, unknown>}, decision: any) => Promise<Suspension>} suspension - A parked call, as the user is asked about it
 * @property {(toolName: string, input: Record<string, unknown>, response: string) => Record<string, unknown>} answer - Fold the user's answer into an elicitation's input
 */

/**
 * The real seams: the thread's inventory, the engine's decision and executor.
 * Imported lazily, because the decision lives in the model layer, which loads
 * the executor that installs this module.
 * @param {any} conversation - The conversation
 * @param {any} messageThread - The thread the program runs in
 * @returns {InvokerDeps} The seams
 */
function defaultDeps(conversation, messageThread) {
  return {
    offeredTools: async () => {
      const { buildToolInventory } = await import('./thread-tool-inventory.js');
      return composableTools((await buildToolInventory(messageThread)).offered);
    },
    decide: async (call) => {
      const { decideToolCall } = await import('../model/conversation-tool-actions.js');
      return decideToolCall({ messageThread, conversation, ...call });
    },
    run: async ({ toolName, input, toolUseId }) => {
      const ItemClass = /** @type {any} */ (contextItemRegistry.getByToolName(toolName));
      const result = await actionExecutor.execute(ItemClass?.MANIFEST?.id || toolName, input, {
        session: conversation.session ?? conversation._session,
        conversation,
        messageThread,
        toolUseId,
        toolName,
        _approvalHandled: true
      });
      // A tool's images ride its summary as asset refs, as they reach the
      // model's tool_result; the caller asks for them (invoke's withAttachments).
      const attachments = Array.isArray(result.formatted?.attachments)
        ? result.formatted.attachments.filter((/** @type {any} */ a) => a && a.id)
        : [];
      return {
        success: !!result.success,
        cancelled: !!result.cancelled,
        content: toolResultContent(result.formatted) || result.error || '',
        error: result.error,
        attachments
      };
    },
    cancel: (toolUseId) => {
      actionExecutor.cancelByToolUseId(toolUseId, conversation?.id);
    },
    // Built as the evaluate path builds a parked call's form
    // (conversation-tool-actions.js), from the decision's own action.
    suspension: async ({ name, args }, decision) => {
      const { buildApprovalOptions } = await import('./response-handler-actions.js');
      const { reviewForSuspension } = await import('../model/conversation-tool-actions.js');
      const built = buildApprovalOptions(decision.action, decision.prepared);
      return {
        name,
        input: args,
        review: reviewForSuspension(messageThread, decision, name, args),
        reason: decision.reason,
        approvalOptions: { ...built, options: keepNamedGrants(built.options || []) },
        displayData: decision.prepared?.displayData,
        note: decision.hookAsks ? decision.reason : undefined
      };
    },
    // As resolveFinalToolInput does for a tool-action: a gate's response is a
    // bare verdict, an elicitation's is the answer.
    answer: (toolName, input, response) => {
      const ItemClass = /** @type {any} */ (contextItemRegistry.getByToolName(toolName));
      if (ItemClass?.interactionKind?.() !== INTERACTION_KIND.ELICITATION) return input;
      return ItemClass.applyApprovalResponse(input, response);
    },
  };
}

/**
 * Create the invoker for one run of a program.
 * @param {object} opts
 * @param {string} opts.parentToolUseId - The program's own tool-use id, the stem of its sub-calls' ids
 * @param {AbortSignal} [opts.signal] - The program's signal; aborting it cancels every call
 * @param {(err: ToolRefused) => void} [opts.onRefused] - Told once, when a refusal ends the program
 * @param {(err: ToolSuspended) => void} [opts.onSuspended] - Told once, when a call the
 *   decision parks ends the program to wait for the user. Without it, a park refuses.
 * @param {any} [opts.conversation] - The conversation (for the default seams)
 * @param {any} [opts.messageThread] - The thread the program runs in (for the default seams)
 * @param {number} [opts.limit] - Calls running at once
 * @param {number} [opts.maxRecords] - Calls kept in the record
 * @param {Partial<InvokerDeps>} [opts.deps] - Seams to replace, for tests
 * @returns {{invoke: (name: string, args: Record<string, unknown>, how?: {withAttachments?: boolean}) => Promise<any>, record: NestedCallRecord, offered: () => Promise<Map<string, Record<string, any>>>, approveNext: (name: string, args: Record<string, unknown>, response: string) => void}} The invoker
 */
export function createToolInvoker(opts) {
  const limit = Math.max(1, opts.limit ?? DEFAULT_LIMIT);
  const maxRecords = Math.max(1, opts.maxRecords ?? DEFAULT_MAX_RECORDS);
  const deps = { ...defaultDeps(opts.conversation, opts.messageThread), ...(opts.deps || {}) };

  /** @type {NestedCallRecord} */
  const record = { calls: [], omitted: 0, omittedEffects: 0 };
  /** @type {Promise<Map<string, Record<string, any>>>|null} */
  let offeredPromise = null;
  /** @type {ToolRefused|null} */
  let refusal = null;
  let ordinal = 0;
  /** @type {{name: string, args: string, response: string}|null} */
  let approved = null;

  /**
   * @typedef {object} Pending
   * @property {string} name - Tool name
   * @property {Record<string, unknown>} args - Its arguments, unclipped
   * @property {string} toolUseId - The id it runs under in the executor
   * @property {boolean} alongside - A read: may overlap its neighbours
   * @property {{response: string}|null} approval - The user's answer, for the held call a replay hands over
   * @property {NestedCall} entry - Its record entry
   * @property {'queued'|'running'|'done'} phase - Where it is in its life
   * @property {(v: {content: string, attachments: AssetRef[]}) => void} resolve - Settles the program's await with a value
   * @property {(e: Error) => void} reject - Settles the program's await with an error
   */
  /** @type {Pending[]} */
  const calls = [];

  /**
   * Keep a call in the record, giving up a read before an effect once full.
   * @param {NestedCall} entry - The call
   */
  const keep = (entry) => {
    if (record.calls.length < maxRecords) {
      record.calls.push(entry);
      return;
    }
    record.omitted++;
    if (entry.effect === undefined) return;
    const evict = record.calls.findIndex((c) => c.effect === undefined);
    if (evict < 0) {
      record.omittedEffects++;
      return;
    }
    record.calls.splice(evict, 1);
    record.calls.push(entry);
  };

  /**
   * Settle a call, finishing its record entry.
   * @param {Pending} call
   * @param {NestedCall['status']} status
   * @param {{value?: {content: string, attachments: AssetRef[]}, error?: Error, startedAt?: number, ran?: boolean}} how -
   *   `ran`: the tool itself was run, past its decision
   */
  const settle = (call, status, how) => {
    call.phase = 'done';
    call.entry.status = status;
    if (how.startedAt !== undefined) call.entry.durationMs = Date.now() - how.startedAt;
    // A call that never ran changed nothing. One that ran keeps its effect even
    // when it failed or was interrupted: a command that exits non-zero, or is
    // stopped halfway, may still have changed the world.
    if (!how.ran) delete call.entry.effect;
    if (how.error) {
      call.entry.error = how.error.message;
      call.reject(how.error);
    } else {
      call.resolve(/** @type {{content: string, attachments: AssetRef[]}} */ (how.value));
    }
    pump();
  };

  /**
   * End the program: refuse every call not yet finished, cancel the running ones.
   * @param {ToolRefused} err - Why
   * @param {NestedCall['status']} queuedStatus - What a call that never ran is recorded as
   */
  const stopAll = (err, queuedStatus) => {
    if (!refusal) refusal = err;
    for (const call of calls) {
      if (call.phase === 'queued') {
        settle(call, queuedStatus, { error: err });
      } else if (call.phase === 'running') {
        deps.cancel(call.toolUseId);
      }
    }
  };

  /**
   * Run one call that the order and the limit have released.
   * @param {Pending} call
   * @returns {Promise<void>}
   */
  const start = async (call) => {
    call.phase = 'running';
    call.entry.status = 'running';
    const startedAt = Date.now();
    let ran = false;
    try {
      // The held call a replay hands over was decided by the user: it is not
      // put to the decision again.
      const decision = call.approval
        ? { verdict: 'approve', reason: '' }
        : await deps.decide({ toolName: call.name, toolInput: call.args, toolUseId: call.toolUseId });
      if (refusal) {
        settle(call, 'cancelled', { error: refusal, startedAt });
        return;
      }
      if (decision.verdict === 'invalid') {
        settle(call, 'error', { error: new ToolError(`Couldn't run ${call.name}: ${decision.reason}`), startedAt });
        return;
      }
      if (decision.verdict === 'park' && opts.onSuspended) {
        const suspension = await deps.suspension({ name: call.name, args: call.args }, decision);
        if (refusal) {
          settle(call, 'cancelled', { error: refusal, startedAt });
          return;
        }
        const err = new ToolSuspended(`${call.name} is waiting for you: ${decision.reason}.`, suspension);
        // Stop first, so settling this call releases nothing queued behind it.
        const stop = new ToolRefused('The program stopped to wait for you.');
        refusal = stop;
        settle(call, 'suspended', { error: err, startedAt });
        stopAll(stop, 'cancelled');
        opts.onSuspended(err);
        return;
      }
      if (decision.verdict !== 'approve') {
        const reason = decision.verdict === 'park'
          ? `${decision.reason}, so call it directly.`
          : decision.reason;
        const err = new ToolRefused(`Couldn't run ${call.name}: ${reason}`);
        // Stop first, as a suspension does, so settling this call releases
        // nothing queued behind it.
        const first = !refusal;
        if (first) refusal = err;
        settle(call, 'refused', { error: err, startedAt });
        stopAll(err, 'refused');
        if (first) opts.onRefused?.(err);
        return;
      }
      const input = call.approval ? deps.answer(call.name, call.args, call.approval.response) : call.args;
      ran = true;
      const result = await deps.run({ toolName: call.name, input, toolUseId: call.toolUseId });
      if (result.cancelled || refusal) {
        settle(call, 'cancelled', { error: refusal || new ToolRefused(`Couldn't finish ${call.name}: it was interrupted.`), startedAt, ran });
      } else if (!result.success) {
        settle(call, 'error', { error: new ToolError(result.content || result.error || `${call.name} failed`), startedAt, ran });
      } else {
        settle(call, 'ok', { value: { content: result.content, attachments: result.attachments ?? [] }, startedAt, ran });
      }
    } catch (err) {
      settle(call, 'error', { error: new ToolError(extractErrorMessage(err)), startedAt, ran });
    }
  };

  /** Release every queued call the order and the limit now allow. */
  function pump() {
    if (refusal) return;
    let running = calls.filter((c) => c.phase === 'running').length;
    let unsettled = false;
    let unsettledBarrier = false;
    for (const call of calls) {
      if (call.phase === 'queued' && running < limit
          && !unsettledBarrier && (call.alongside || !unsettled)) {
        running++;
        void start(call);
      }
      if (call.phase === 'done') continue;
      unsettled = true;
      if (!call.alongside) unsettledBarrier = true;
    }
  }

  opts.signal?.addEventListener('abort', () => {
    stopAll(new ToolRefused('The program was interrupted.'), 'cancelled');
    // A running call whose cancel lands is recorded as cancelled when it returns.
    for (const call of calls) if (call.phase === 'running') call.entry.status = 'cancelled';
  }, { once: true });

  /**
   * Call one tool from the program.
   * @param {string} name - Tool name
   * @param {Record<string, unknown>} args - Its arguments
   * @param {{withAttachments?: boolean}} [how] - withAttachments: resolve
   *   `{content, attachments}`, the asset refs of any images the call produced,
   *   rather than the content alone. The record never holds either.
   * @returns {Promise<any>} What the tool returned: its content, or with its attachments
   */
  async function invoke(name, args, how = {}) {
    const input = (args && typeof args === 'object') ? args : {};
    // Taken before the first await, by the call approveNext named — the same
    // tool with the same arguments — and by no other: the user approved that
    // call, not its tool.
    const approval = approved?.name === name && approved.args === argsIdentity(input)
      ? { response: approved.response } : null;
    approved = null;
    /** @type {NestedCall} */
    const entry = { name, args: clipArg(input), status: 'queued' };
    if (refusal || opts.signal?.aborted) {
      entry.status = refusal ? 'refused' : 'cancelled';
      keep(entry);
      throw refusal || new ToolRefused('The program was interrupted.');
    }
    const def = (await offered()).get(name);
    if (!def) {
      entry.status = 'error';
      entry.error = `Couldn't run ${name}: it wasn't available in this thread.`;
      keep(entry);
      throw new ToolError(entry.error);
    }
    const alongside = def.category === 'read' || def.category === 'meta';
    if (!alongside) entry.effect = effectLine(name, input);
    keep(entry);
    /** @type {Promise<{content: string, attachments: AssetRef[]}>} */
    const settled = new Promise((resolve, reject) => {
      calls.push({
        name, args: input, alongside, entry, phase: 'queued', resolve, reject, approval,
        toolUseId: `code_${opts.parentToolUseId}_${++ordinal}`,
      });
      if (refusal) {
        settle(/** @type {Pending} */ (calls[calls.length - 1]), 'refused', { error: refusal });
        return;
      }
      pump();
    });
    const value = await settled;
    return how.withAttachments ? value : value.content;
  }

  /**
   * The tools a call is admitted to, by name: the thread's offered tools that a
   * program may call. Built once per program, so admission and anything that
   * describes the admitted set (a program's own listing) cannot disagree.
   * @returns {Promise<Map<string, Record<string, any>>>} The admitted tools
   */
  function offered() {
    if (!offeredPromise) {
      offeredPromise = deps.offeredTools().then((defs) => new Map(
        defs.filter((d) => isComposableTool(/** @type {any} */ (d))).map((d) => [d.name, d])
      ));
    }
    return offeredPromise;
  }

  /**
   * Hand the next call over as approved by the user, with their response (a
   * verdict, or an elicitation's answer), if it is the call they were asked
   * about: `name` with `args` (key order aside). For the call a program was
   * suspended on, made again by its replay at the same step. The next call
   * takes the approval or discards it, so it never reaches a later one.
   * @param {string} name - The held tool
   * @param {Record<string, unknown>} args - Its arguments, as the user was shown them
   * @param {string} response - The user's approval response
   */
  function approveNext(name, args, response) {
    approved = { name, args: argsIdentity(args), response };
  }

  return { invoke, record, offered, approveNext };
}

/**
 * Install the host binding the SDK reaches the invoker through
 * (`ContextItem#createToolInvoker`), so an extension's tool never imports this
 * module. Wherever the executor loads — every engine host — the binding exists.
 */
/** @type {any} */ (globalThis).__hostToolInvoker = createToolInvoker;
