//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests for `<thinking-block>` (`components/thinking-block.js`): the
 * panel's own heading follows the UI language, collapsed and expanded.
 * @module unit-tests/thinking-block-test
 */

import '../../js/components/thinking-block.js';
import { assert } from '../utilities/test-helpers.js';
import { underPseudoLocale, shownStrings } from '../utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';

/**
 * Run the thinking-block test suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label - Test label.
   * @param {() => (void | Promise<void>)} fn - Test body.
   */
  const run = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  await run('the heading follows the UI language, collapsed and expanded', async () => {
    await underPseudoLocale('thinking-block-test', () => {
      /** @type {string[]} */
      const shown = [];
      for (const expanded of [false, true]) {
        const block = document.createElement('thinking-block');
        // The thinking and its signature are the model's own data; the icon is a glyph.
        block.setAttribute('thinking', '1');
        block.setAttribute('signature', '2');
        if (expanded) block.setAttribute('expanded', '');
        document.body.appendChild(block);
        try {
          shown.push(...shownStrings(block, '.thinking-block-text, .thinking-block-signature, .thinking-block-icon'));
        } finally {
          block.remove();
        }
      }
      assert(shown.length === 2, `expected the heading in both states, got ${JSON.stringify(shown)}`);
      const raw = shown.filter((s) => !isPseudoLocalized(s));
      assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
    });
  });

  return { passed, failed, errors };
}
