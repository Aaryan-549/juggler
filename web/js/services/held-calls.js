//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Held calls: a running tool-action that waits on the user for one of its own
 * calls without stopping.
 *
 * A program tool (run_code) whose call the approval decision parks holds that
 * call here. Its item goes to `pending` with the held call's approval form, as
 * a parked call's does, while its execution goes on in the engine, waiting.
 * The user answers as they answer any parked call (`resolveApproval`), and the
 * worker commands the approved item into the engine as usual; handleExecuteTool
 * finds the execution already in flight, and instead of starting another
 * hands the answer to the waiting call (`heldDelivery`).
 *
 * The answer is the held call's only when the user gave it on that call's own
 * card (`approvalOptions.held`). A strategy switch resets the item and
 * clears the form, and the item may then be approved on its own account; the
 * waiting call is then put to the decision again (`{redecide: true}`), never
 * handed an answer to another question.
 *
 * Anything that settles the item while a call is held — a denial, a refusal
 * on the user's behalf, a cancel — ends the execution through the executor, so
 * it exits without a result of its own and the settled one stands.
 *
 * What a held item is not: a pending item whose execution has ended. An engine
 * that dies while a call is held leaves the pending item and nothing waiting
 * for it; the program tool then resumes, if it can, when it is executed again.
 * @module services/held-calls
 */

import actionExecutor from './action-executor.js';
import { TOOL_STATES } from '../../sdk/lib/message.js';

/** @typedef {import('./tool-invoker.js').HoldRequest} HoldRequest */

/**
 * The user's answer to a held call: their response, or that the call is to be
 * decided again because the answer was not theirs to give it.
 * @typedef {{response: string, redecide?: undefined}|{redecide: true, response?: undefined}} HeldAnswer
 */

/**
 * @typedef {object} Waiter
 * @property {(answer: HeldAnswer) => void} deliver - Hands the answer to the waiting call
 */

/**
 * Held calls waiting on the user, by conversation and tool-use id (an id is
 * unique only within a conversation).
 * @type {Map<string, Waiter>}
 */
const waiters = new Map();

/**
 * @param {string|undefined} conversationId - The conversation
 * @param {string} toolUseId - The tool-action
 * @returns {string} The waiter's key
 */
const keyOf = (conversationId, toolUseId) => JSON.stringify([conversationId ?? '', toolUseId]);

/**
 * @param {any} v - A Yjs value or a plain one
 * @returns {any} It, plain
 */
const plain = (v) => (v?.toJSON ? v.toJSON() : v);

/** The fields that make a held call's card, cleared once it is answered. */
const CARD_FIELDS = ['heldCall', 'approvalOptions', 'reviewStatus'];

/**
 * Hold a call of a running tool-action for the user: put the item in front of
 * them with the call's approval form, and wait for their answer.
 * @param {object} opts
 * @param {any} opts.conversation - The conversation
 * @param {any} opts.messageThread - The item's thread
 * @param {string} opts.toolUseId - The running tool-action
 * @param {HoldRequest} opts.request - The call, as the user is asked about it
 * @param {AbortSignal} [opts.signal] - Ends the wait (the program has ended)
 * @returns {Promise<HeldAnswer>} The user's answer. Rejects when the item is
 *   settled under the call, when the signal aborts, or when the item is not
 *   running and so cannot ask
 */
export function holdForUser({ conversation, messageThread, toolUseId, request, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('The program ended.'));
      return;
    }
    const conversationId = conversation?.id;
    const key = keyOf(conversationId, toolUseId);
    if (waiters.has(key) || !messageThread?.holdToolAction?.(toolUseId, request)) {
      reject(new Error(`Couldn't run ${request.name}: it needs your approval, and nothing can ask you for it here.`));
      return;
    }
    const ymap = messageThread.getToolAction(toolUseId);
    actionExecutor.markHeld(toolUseId, conversationId, true);

    const finish = () => {
      waiters.delete(key);
      ymap?.unobserve(onChange);
      signal?.removeEventListener('abort', onAbort);
      actionExecutor.markHeld(toolUseId, conversationId, false);
    };
    const onChange = () => {
      const state = ymap.get('state');
      if (state !== TOOL_STATES.CANCELLED && state !== TOOL_STATES.COMPLETED) return;
      finish();
      // Its result is already written: end the execution without one.
      actionExecutor.cancelByToolUseId(toolUseId, conversationId);
      reject(new Error(state === TOOL_STATES.CANCELLED
        ? `Couldn't run ${request.name}: you declined it.`
        : `Couldn't run ${request.name}: it was refused.`));
    };
    const onAbort = () => {
      finish();
      reject(new Error('The program ended.'));
    };
    ymap?.observe(onChange);
    signal?.addEventListener('abort', onAbort, { once: true });
    waiters.set(key, {
      deliver: (answer) => {
        finish();
        resolve(answer);
      }
    });

    if (request.review) {
      // As a parked call's reviewer is: after the write, fire-and-forget.
      const review = request.review;
      void import('../model/conversation-tool-actions.js')
        .then((m) => m.offerHoldToReviewer(messageThread, toolUseId, review));
    }
  });
}

/**
 * The handover of an approved item's answer to its held call, if one waits.
 *
 * Returned rather than done, so the caller can act first on the approval as an
 * approval (a "don't ask again" grant), with nothing between the two to change
 * the item. Delivering moves the item back to running in one engine-derived
 * write, clearing the held call's card, and hands the waiting call its answer.
 * @param {any} conversation - The conversation (engineDerivedUpdate)
 * @param {any} ymap - The approved tool-action
 * @param {string} toolUseId - Its id
 * @returns {(() => void)|null} Delivers the answer; null when no call of this
 *   item is held, or the item is not approved
 */
export function heldDelivery(conversation, ymap, toolUseId) {
  const waiter = waiters.get(keyOf(conversation?.id, toolUseId));
  if (!waiter || ymap?.get('state') !== TOOL_STATES.APPROVED) return null;
  const response = ymap.get('approvalResponse');
  /** @type {HeldAnswer} */
  const answer = plain(ymap.get('approvalOptions'))?.held && typeof response === 'string'
    ? { response }
    : { redecide: true };
  return () => {
    conversation.engineDerivedUpdate(() => {
      ymap.set('state', TOOL_STATES.RUNNING);
      for (const field of CARD_FIELDS) ymap.delete(field);
    });
    waiter.deliver(answer);
  };
}

/**
 * Put an item whose program ended while a call was held back to running, so
 * its result lands on a running item and nothing reads it as waiting on the
 * user. A settled or running item is left as it is. For a program that held a
 * call: anything else may be pending for reasons of its own.
 * @param {any} messageThread - The item's thread
 * @param {string} toolUseId - The tool-action
 */
export function releaseHold(messageThread, toolUseId) {
  const ymap = messageThread?.getToolAction?.(toolUseId);
  if (!ymap) return;
  const state = ymap.get('state');
  if (state !== TOOL_STATES.PENDING && state !== TOOL_STATES.APPROVED) return;
  messageThread.transact(() => {
    ymap.set('state', TOOL_STATES.RUNNING);
    for (const field of CARD_FIELDS) ymap.delete(field);
  });
}
