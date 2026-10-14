//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests: the text of an approval's buttons.
 *
 * `buildApprovalButtons` runs in the engine and its options are stored in the
 * conversation, so their labels are English data; `<action-confirmation>`
 * translates them, and words the "don't ask again" descriptor, where it draws
 * them. Under en-XA nothing the buttons show may be plain English. The
 * fixture's patterns are digits, which read as data inside a message.
 * @module unit-tests/approval-buttons
 */

import { assert, waitFor } from '../utilities/test-helpers.js';
import { underPseudoLocale, assertPseudoLocalized } from '../utilities/pseudo-locale.js';
import { buildApprovalButtons } from '../../js/services/approval-options.js';
import { buildApprovalOptions } from '../../js/services/response-handler-actions.js';
import { handleApprovalRequest } from '../../js/model/session-worker-callbacks.js';
import contextItemRegistry from '../../js/registries/context-item-registry.js';
import ContextItem from '../../sdk/context-item.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';
import '../../js/components/action-confirmation.js';

/**
 * Render the standard buttons for `suggestions` in a fresh `<action-confirmation>`.
 * @param {any[]} suggestions - What the plugin's `getApprovalSuggestions` returns.
 * @param {object} [extra] - `setOptions`'s third argument.
 * @returns {any} The element, attached to the document.
 */
function render(suggestions, extra) {
  const el = /** @type {any} */ (document.createElement('action-confirmation'));
  document.body.appendChild(el);
  el.setOptions({ options: buildApprovalButtons({ getApprovalSuggestions: () => suggestions }, {}) }, () => {}, extra);
  return el;
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];
  /** @type {HTMLElement[]} */
  const made = [];

  /**
   * @param {string} label - Test label.
   * @param {() => Promise<void>} fn - Test body.
   */
  const run = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      made.splice(0).forEach((el) => el.remove());
    }
  };

  const rules = [{ kind: 'glob', value: '1' }];

  await run('the stored labels are the English source', async () => {
    const opts = buildApprovalButtons({ getApprovalSuggestions: () => [{ itemType: 'execute', rules, patterns: ['1'] }] }, {});
    const labels = opts.map((o) => o.label);
    assert(JSON.stringify(labels) === JSON.stringify(['Yes', "Yes + Don't Ask Again", 'No']),
      `expected English labels in the options, got ${JSON.stringify(labels)}`);
  });

  await run('under en-XA every button shape shows only translated text', async () => {
    await underPseudoLocale('approval-buttons-test', async () => {
      const plain = render([]);
      made.push(plain);
      assertPseudoLocalized(plain, { atLeast: 2, where: 'Yes / No' });

      const single = render([{ itemType: 'execute', rules, patterns: ['1'] }],
        { onRevise: () => ({ valid: false }) });
      made.push(single);
      assert(!!single.querySelector('.pattern-edit-btn'), 'the single-pattern option drew no pencil');
      assertPseudoLocalized(single, { atLeast: 4, where: 'one command pattern, editable' });

      // Lanes share one window's focus, and a blur of the edit input cancels the
      // edit (hiding the notice for good), so a sibling lane's focus() would
      // fail this case. The input's focus and select calls (WebKit's select()
      // focuses too) are observed rather than made; the decoy stands in for the
      // sibling.
      const input = /** @type {HTMLInputElement} */ (single.querySelector('.pattern-edit-input'));
      let focusAsked = false;
      input.focus = () => { focusAsked = true; };
      input.select = () => {};
      const decoy = document.createElement('button');
      document.body.appendChild(decoy);
      made.push(decoy);
      single.querySelector('.pattern-edit-btn').click();
      decoy.focus();
      assert(focusAsked, 'editing did not put the cursor in the pattern input');
      await waitFor(() => !single.querySelector('.pattern-edit-notice')?.hidden,
        { description: 'the invalid-pattern notice' });
      assertPseudoLocalized(/** @type {Element} */ (single.querySelector('.pattern-edit-field')),
        { where: 'invalid edit' });

      const two = render([{ itemType: 'execute', rules, patterns: ['1', '2'] }]);
      made.push(two);
      assertPseudoLocalized(two, { atLeast: 3, where: 'two patterns' });

      const three = render([{ itemType: 'execute', rules, patterns: ['1', '2', '3'] }]);
      made.push(three);
      assertPseudoLocalized(three, { atLeast: 3, where: 'three patterns' });

      const folder = render([{ itemType: 'read-file', allowedPaths: ['/1'], patterns: ['/1'] }]);
      made.push(folder);
      assertPseudoLocalized(folder, { atLeast: 3, where: 'folder grant' });
    });
  });

  // The approval's title and message are built in the engine, which follows the
  // UI language, beside the plugin's own (already translated) getTitle(): they
  // are stored translated, and the plugins that show the title show it as it
  // is. Fallback buttons are English data like the standard set, translated
  // where they are drawn. A validator's error is the model's English and stays
  // so. Tool names and titles here are digits, so they read as data.
  await run('the approval text the engine builds is translated under en-XA', async () => {
    if (!contextItemRegistry.isInitialized()) await contextItemRegistry.init();
    /**
     * Drive the real approval handler with `ActionClass` (null = unknown tool)
     * and return what it stored on the tool action.
     * @param {any} ActionClass - Class the tool name resolves to, or null
     * @returns {Promise<any>} The stored approval options
     */
    const stored = async (ActionClass) => {
      /** @type {any} */
      let written = null;
      const thread = {
        items: [{ get: (/** @type {string} */ k) => ({ type: 'tool-action', toolUseId: 't1' })[k] }],
        updateItemField: (/** @type {number} */ _i, /** @type {string} */ _f, /** @type {any} */ v) => { written = v; },
      };
      const conv = { findMessageThreadForToolUse: () => thread, rootMessageThread: thread };
      const session = { conversations: new Map([['c1', conv]]) };
      const original = contextItemRegistry.getByToolName;
      contextItemRegistry.getByToolName = () => ActionClass;
      try {
        await handleApprovalRequest(session, { toolUseId: 't1', toolName: '1', toolInput: {} }, 'c1');
      } finally {
        contextItemRegistry.getByToolName = original;
      }
      assert(written, 'the handler stored no approval options');
      return written;
    };
    /**
     * @param {string} [error] - The validator's error, if it gives one
     * @returns {any} A context-item class whose input never validates
     */
    const invalidClass = (error) => class extends ContextItem {
      getTitle() { return '2'; }
      async validate() { return { valid: false, error }; }
    };
    class Throws extends ContextItem {
      async validate() { throw new Error('3'); }
    }

    await underPseudoLocale('approval-buttons-test-engine', async () => {
      const unknown = await stored(null);
      const invalid = await stored(invalidClass());
      const rejected = await stored(invalidClass('bad value'));
      const broken = await stored(Throws);
      const built = buildApprovalOptions({
        getManifest: () => ({ id: 'read-file', name: 'Read File' }),
        getApprovalSuggestions: () => [],
      }, {});

      const text = {
        'unknown tool title': unknown.title,
        'invalid title': invalid.title,
        'invalid message': invalid.message,
        'broken message': broken.message,
        'default title': built.title,
      };
      const raw = Object.entries(text).filter(([, s]) => !isPseudoLocalized(s));
      assert(raw.length === 0, `plain English approval text under en-XA: ${JSON.stringify(raw)}`);
      assert(rejected.message === 'bad value', `the validator's error is shown as given, got ${rejected.message}`);

      const labels = [...unknown.options, ...invalid.options, ...broken.options].map((/** @type {any} */ o) => o.label);
      assert(JSON.stringify(labels) === JSON.stringify(['Allow', 'Deny', 'Cancel', 'Allow', 'Deny']),
        `fallback buttons are stored as English, got ${JSON.stringify(labels)}`);
      for (const [where, opts] of [['allow/deny', unknown], ['cancel', invalid]]) {
        const el = /** @type {any} */ (document.createElement('action-confirmation'));
        document.body.appendChild(el);
        made.push(el);
        el.setOptions({ options: opts.options }, () => {});
        assertPseudoLocalized(el, { where });
      }
    }, { '@juggler/core': ['Read File'] });
  });

  return { passed, failed, errors };
}
