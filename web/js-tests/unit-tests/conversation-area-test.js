//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * What the transcript column draws of its own follows the UI language: the
 * thread actions and scroll controls in its template, the thread header's
 * lozenge, the footer status while a tool waits for approval, and the
 * suggestions row's label and starter prompts in both of its states.
 *
 * The column is rendered detached and never connected, so nothing reaches the
 * server; the footer and the suggestions row are stand-ins that record what
 * they are handed. The thread's goal is data, written in digits.
 * @module unit-tests/conversation-area-test
 */

import '../../js/components/conversation-area.js';
import {
  areReplySuggestionsEnabled,
  isReplySuggestionsSettingSeeded,
  resetReplySuggestionsSettingForTests,
  setReplySuggestionsEnabledCached,
} from '../../js/services/reply-suggestions-setting.js';
import { MESSAGE_TYPES } from '../../sdk/lib/message.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';
import { assert } from '../utilities/test-helpers.js';
import { underPseudoLocale, shownStrings } from '../utilities/pseudo-locale.js';

/**
 * An item that reads like a Y.Map.
 * @param {Record<string, any>} fields
 * @returns {{get: (key: string) => any}} The stand-in item.
 */
function item(fields) {
  return { get: (key) => fields[key] };
}

/**
 * A rendered, unconnected column whose footer and suggestions row record what
 * they are given.
 * @returns {{area: any, footer: any[], row: Array<{suggestions: string[], label: string}>}} The column and its records.
 */
function standInColumn() {
  const area = /** @type {any} */ (document.createElement('conversation-area'));
  area.render();
  /** @type {any[]} */
  const footer = [];
  /** @type {Array<{suggestions: string[], label: string}>} */
  const row = [];
  area._getFooter = () => ({
    setStatusOnly: () => {},
    update: (/** @type {any} */ state) => { footer.push(state); },
  });
  Object.defineProperty(area, 'suggestionsRow', {
    value: { update: (/** @type {string[]} */ suggestions, /** @type {string} */ label) => { row.push({ suggestions, label }); } },
  });
  return { area, footer, row };
}

/**
 * A root message thread holding `items`, with `approvals` waiting.
 * @param {any[]} items
 * @param {number} approvals
 * @returns {any} The stand-in thread.
 */
function rootThread(items, approvals) {
  return {
    threadItemId: null,
    items,
    isProcessing: false,
    lastActivityAt: 0,
    getMessages: () => items,
    hasBusyItems: () => false,
    getPendingApprovalMessages: () => Array.from({ length: approvals }, () => ({})),
  };
}

/**
 * Run the conversation-area test suite.
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

  await run('en-XA: everything the transcript column draws of its own is translated', async () => {
    // The starter prompts ride a module-level setting; pin it on, and put back
    // whatever this lane had.
    const wasSeeded = isReplySuggestionsSettingSeeded();
    const wasEnabled = areReplySuggestionsEnabled();
    setReplySuggestionsEnabledCached(true);
    try {
      await underPseudoLocale('conversation-area-test', async () => {
        /** @type {Array<[string, string]>} */
        const seen = [];
        /**
         * @param {string} where - The state drawn
         * @param {string[]} strings - What it showed
         * @param {number} atLeast - How many it must have shown
         * @returns {void}
         */
        const see = (where, strings, atLeast) => {
          assert(strings.length >= atLeast, `${where}: expected at least ${atLeast} strings, got ${JSON.stringify(strings)}`);
          for (const s of strings) seen.push([where, s]);
        };

        // The template's thread actions and scroll controls, with the header a
        // thread column shows: the goal is data, the lozenge is not.
        {
          const { area } = standInColumn();
          area._messageThread = rootThread([], 0);
          area.showThreadHeader('7', item({ type: 'thread', itemId: 't7', goal: '7', boundedCompaction: true }));
          const header = area.querySelector('.thread-column-header');
          assert(!!header && !header.classList.contains('hidden'), 'the thread header was not shown');
          assert(header?.querySelector('.thread-column-goal')?.textContent === '7', 'the header did not show the goal');
          see('thread header', shownStrings(/** @type {Element} */ (header), '.thread-column-goal'), 1);
          const actions = area.querySelector('thread-column-actions');
          assert(!!actions && !actions.classList.contains('hidden'), 'the thread actions were not shown');
          see('thread actions', shownStrings(/** @type {Element} */ (actions)), 4);
          const scrolls = area.querySelector('#scroll-controls');
          assert(!!scrolls, 'the template drew no scroll controls');
          see('scroll controls', shownStrings(/** @type {Element} */ (scrolls)), 4);
        }

        // The footer while a tool waits for approval.
        {
          const { area, footer } = standInColumn();
          area._messageThread = rootThread([item({ type: MESSAGE_TYPES.USER, content: '7' })], 1);
          area.updateFooter();
          const last = footer[footer.length - 1];
          assert(!!last?.statusMessage, `no status while waiting for approval: ${JSON.stringify(last)}`);
          see('awaiting approval', [last.statusMessage], 1);
        }

        // The suggestions row before anything has been said: its label and the
        // starter prompts it offers.
        {
          const { area, row } = standInColumn();
          area._messageThread = rootThread([], 0);
          area.updateFooter();
          const last = row[row.length - 1];
          assert(!!last && last.suggestions.length > 0, `no starter prompts offered: ${JSON.stringify(last)}`);
          see('starters', [last.label, ...last.suggestions], 2);
        }

        // The suggestions row once the conversation has started.
        {
          const { area, row } = standInColumn();
          area._messageThread = rootThread([item({ type: MESSAGE_TYPES.USER, content: '7' })], 0);
          area.updateFooter();
          const last = row[row.length - 1];
          assert(!!last, 'the row was never updated');
          see('started', [last.label], 1);
        }

        const raw = seen.filter(([, s]) => !isPseudoLocalized(s)).map(([where, s]) => `${where}: ${JSON.stringify(s)}`);
        assert(raw.length === 0, `plain English under en-XA:\n  ${raw.join('\n  ')}`);
      });
    } finally {
      if (wasSeeded) setReplySuggestionsEnabledCached(wasEnabled);
      else resetReplySuggestionsSettingForTests();
    }
  });

  return { passed, failed, errors };
}
