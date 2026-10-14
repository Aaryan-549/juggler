//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests for the UI defaults of the SDK base class (`sdk/context-item.js`):
 * the transcript row's terminal states (`resolveTerminalStatus` /
 * `buildStatusUI`), the properties panel's `Input` and `Result` labels and the
 * bare item body follow the UI language, and the default labels a host draws
 * through its own `t()` are catalogue messages. The model's summary stays
 * English.
 * @module unit-tests/context-item-base-test
 */

import ContextItem from '../../sdk/context-item.js';
import { t, isPseudoLocalized } from '../../sdk/lib/i18n.js';
import { assert } from '../utilities/test-helpers.js';
import { underPseudoLocale } from '../utilities/pseudo-locale.js';

/** A capability that overrides nothing, so every default is the base class's. */
class BareItem extends ContextItem {}

/**
 * A minimal instance; the base constructor only needs these to be present.
 * @returns {BareItem} An item with no manifest and no overrides.
 */
function bareItem() {
  return new BareItem(/** @type {any} */ ({ id: '1', session: {}, conversation: {}, messageThread: {} }));
}

/**
 * Run the context-item base-class test suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  /** @type {string[]} */
  const errors = [];
  let passed = 0;
  let failed = 0;

  /**
   * @param {string} name
   * @param {() => Promise<void>} fn
   */
  const run = async (name, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  await run('en-XA: the base class draws no plain English, and the model reads English', async () => {
    await underPseudoLocale('context-item-base-test', async () => {
      const item = bareItem();
      /** @type {Record<string, string>} */
      const shown = {};

      // The transcript row's terminal states. The error is the model's text and
      // the prefix the plugin's; both are digits so only the message shows.
      shown['cancelled'] = String(item.resolveTerminalStatus({ cancelled: true }, '1').summary);
      shown['prefixed error'] = String(item.resolveTerminalStatus({ error: '2' }, '1').summary);
      shown['unknown error'] = String(item.resolveTerminalStatus({}, undefined).summary);
      shown['prefixed unknown error'] = String(item.resolveTerminalStatus({}, '1').summary);
      const row = item.buildStatusUI({ cancelled: true }, { typeName: '3', success: '4' });
      shown['row cancelled'] = String(row?.summary);
      const failedRow = item.buildStatusUI({ error: '2' }, { typeName: '3', success: '4', failurePrefix: '1' });
      shown['row failed'] = String(failedRow?.summary);

      // The properties panel: the Input subsection label and the Result label.
      /** @type {string[]} */
      const labels = [];
      item.renderToolActionDetails(document.createElement('div'), /** @type {any} */ ({
        input: { a: 1 },
        helpers: { addSubsection: (/** @type {any} */ _w, /** @type {string} */ label) => { labels.push(label); } },
      }));
      assert(labels.length === 1, `expected one Input subsection, got ${labels.length}`);
      shown['input label'] = labels[0] ?? '';
      shown['result label'] = BareItem.getResultSectionLabel('5');

      // The body of an item that has no type to show.
      item.type = '';
      shown['bare body'] = item.createPropertiesPanelElement().textContent || '';

      // Labels a host translates with its own (scoped) t(): the badge's static
      // type label and manifest name, and the approval title's manifest name.
      shown['type name'] = t(BareItem.getTypeName());
      shown['manifest name'] = t(item.getManifest().name);

      const raw = Object.entries(shown).filter(([, s]) => !isPseudoLocalized(s));
      assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(Object.fromEntries(raw))}`);

      // What the model reads stays English under en-XA.
      const summaries = [
        item.getSummary(/** @type {any} */ ({ success: true })).summary,
        item.getSummary(/** @type {any} */ ({ success: false, denied: true })).summary,
        item.getSummary(/** @type {any} */ ({ success: false, cancelled: true })).summary,
        item.getSummary(/** @type {any} */ ({ success: false, error: '2' })).summary,
        ContextItem.validateSummary(/** @type {any} */ (null)).summary,
      ];
      const expected = ['Action completed', 'Action denied by user', 'Action cancelled', 'Action failed: 2', 'Error formatting result'];
      assert(JSON.stringify(summaries) === JSON.stringify(expected),
        `the model's summaries changed under en-XA: ${JSON.stringify(summaries)}`);
      item._truncationBudget = 20;
      const note = item.truncateForLLM('x'.repeat(200));
      assert(note.includes('(Output truncated from 200 to'), `truncation note is not plain English: ${JSON.stringify(note.slice(-80))}`);
    });
  });

  return { passed, failed, errors };
}
