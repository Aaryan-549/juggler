//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * There is no context preview modal. A `<context-preview-modal>` element and the
 * text-with-sections renderer behind it were defined and loaded on every page
 * while nothing ever created the element or called it, so the whole surface was
 * unreachable and drifted unseen. This pins its absence: a preview that comes
 * back comes back with an entry point and a test of its own.
 * @module unit-tests/context-preview-absent-test
 */

import { assert } from '../utilities/test-helpers.js';
import { ContextBuilder } from '../../js/services/context-builder.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/**
 * @returns {Promise<TestResult>} Aggregated results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name - What is being checked.
   * @param {() => void} body - The check.
   */
  const check = (name, body) => {
    try { body(); passed++; }
    catch (e) { failed++; errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); }
  };

  check('no <context-preview-modal> element is defined', () => {
    assert(customElements.get('context-preview-modal') === undefined,
      'context-preview-modal is registered, but nothing creates one');
  });

  check('the context builder renders no text-with-sections preview', () => {
    assert(!('renderTextWithSections' in ContextBuilder.prototype),
      'ContextBuilder still carries renderTextWithSections, which only the preview read');
  });

  return { passed, failed, errors };
}
