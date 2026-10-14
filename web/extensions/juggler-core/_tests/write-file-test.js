//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests: what the Write tool shows the user, under en-XA.
 *
 * The approval warning for a target outside the project, the row in every
 * state with its type name, and the outcome banner above the preview are UI
 * text, so each is translated. The model's result (`getSummary`) stays English.
 * Paths and errors are digits, so they read as data inside a message.
 * @module unit-tests/write-file-test
 */

import { underPseudoLocale } from '../../../js-tests/utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../../sdk/lib/i18n.js';
import WriteFileContextItem from '../context-items/write-file-context-item.js';

/** juggler-core's English for this plugin, standing in for its catalogue. */
const CORE_TEXT = [
  '⚠ Write outside the project folder: {path}',
  'Write', 'Created {file}', 'Updated {file}', 'cancelled: {file}',
  'Result', 'Cancelled', 'Error',
];

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated results
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const session = { platform: 'darwin', home: '/1', projectPath: '/2' };
  const messageThread = { getAllowedPaths: () => ['/2'], getRulesFor: () => [], items: [] };
  const item = new WriteFileContextItem(/** @type {any} */ ({
    id: 'w', session, conversation: { id: 'c', session }, messageThread,
  }));

  try {
    await underPseudoLocale('write-file-test', async () => {
      /** @type {Record<string, string>} */
      const shown = {};

      const approval = await item.getApprovalConfig({ path: '/3/4', content: '5' });
      shown['approval, outside the project'] = String(approval?.message);

      const input = { file_path: '/2/6', content: '7' };
      /** @type {Array<[string, any]>} */
      const states = [
        ['created', { success: true, result: { path: '/2/6', created: true, size: 1 } }],
        ['updated', { success: true, result: { path: '/2/6', created: false, size: 1 } }],
        ['cancelled', { success: false, cancelled: true }],
      ];
      for (const [name, status] of states) {
        const ui = /** @type {any} */ (item.getStatusUI(status, input));
        shown[`row ${name}`] = String(ui?.summary);
        shown[`type name ${name}`] = String(ui?.typeName);
      }

      for (const [name, result] of [['cancelled', { cancelled: true }], ['failed', { isError: true }]]) {
        const wrapper = document.createElement('div');
        /** @type {any} */ (item)._appendOutcomeBanner(wrapper, result);
        shown[`banner ${name} heading`] = String(wrapper.querySelector('.properties-panel-subtitle')?.textContent);
        shown[`banner ${name}`] = String(wrapper.querySelector('.properties-panel-result')?.textContent);
      }

      const raw = Object.entries(shown).filter(([, s]) => !isPseudoLocalized(s));
      if (raw.length) throw new Error(`plain English under en-XA: ${JSON.stringify(raw)}`);

      // The model's result is unchanged English under any UI language.
      const summary = item.getSummary(/** @type {any} */ ({ success: true, result: { path: '/2/6', created: true, size: 1 } }));
      if (summary.summary !== 'Created file: /2/6') throw new Error(`the model's result changed: ${JSON.stringify(summary.summary)}`);
    }, { '@juggler/core': CORE_TEXT });
    passed++;
  } catch (e) {
    failed++;
    errors.push(`en-XA: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { passed, failed, errors };
}
