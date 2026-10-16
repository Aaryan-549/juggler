//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * `Conversation.handleError` takes an error frame's text as an error, whatever
 * words it contains. No producer sends a cancellation through that path, so a
 * message that merely mentions cancelling is still a failure to be logged.
 * @module unit-tests/conversation-error-test
 */

import { assert } from '../utilities/test-helpers.js';
import Conversation from '../../js/model/conversation.js';

/**
 * A Conversation carrying only what handleError reads: the real prototype, an
 * LLM state reporting the conversation as processing, and a counted
 * _finishProcessing.
 * @returns {any} The stand-in conversation.
 */
function makeConversation() {
  const conv = Object.create(Conversation.prototype);
  conv.id = 'conv-error-test';
  conv._llmState = { isConversationProcessing: () => true };
  conv.finished = 0;
  conv._finishProcessing = () => { conv.finished++; };
  return conv;
}

/**
 * Run the conversation error test suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Counts of passed/failed checks and any error messages.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name
   * @param {() => void} body
   */
  const check = (name, body) => {
    try {
      body();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  check('error-mentioning-cancel-is-an-error', () => {
    const message = "Couldn't cancel the download";
    const conv = makeConversation();
    /** @type {string[]} */
    const logged = [];
    const original = console.error;
    console.error = (...args) => { logged.push(args.map(String).join(' ')); };
    try {
      conv.handleError(message);
    } finally {
      console.error = original;
    }
    assert(logged.includes(`[Conversation] Error: ${message}`),
      `an error whose text mentions cancelling is logged as an error; logged ${JSON.stringify(logged)}`);
    assert(conv.finished === 1, `processing finishes once, got ${conv.finished}`);
  });

  return { passed, failed, errors };
}
