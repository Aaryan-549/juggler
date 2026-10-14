//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests: the transcript rows of AboutJuggler and ReadJugglerSource, under
 * en-XA — the failure prefix drawn inside core's `{prefix}: {error}`, and every
 * other state and type name. Inputs and errors are digits, so they read as data.
 * @module unit-tests/about-status-rows-test
 */

import { underPseudoLocale } from '../../../js-tests/utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../../sdk/lib/i18n.js';
import AboutJugglerContextItem from '../context-items/about-juggler-context-item.js';
import JugglerSourceContextItem from '../context-items/juggler-source-context-item.js';

/** This extension's English for these rows, standing in for its catalogue. */
const ABOUT_TEXT = [
  'About Juggler', 'Looking up Juggler…', 'Failed',
  'Juggler Source', 'Reading Juggler source…', 'Juggler source', 'Manual', 'Source',
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
  /**
   * @param {any} Cls
   * @returns {any} A plugin instance on stub session/conversation/thread.
   */
  const make = (Cls) => new Cls({ id: 'x', session, conversation: { id: 'c', session }, messageThread });

  try {
    await underPseudoLocale('about-status-rows-test', async () => {
      /** @type {Record<string, string>} */
      const shown = {};
      /**
       * @param {string} name
       * @param {any} ui
       */
      const row = (name, ui) => {
        shown[`${name} row`] = String(ui?.summary);
        shown[`${name} type name`] = String(ui?.typeName);
      };

      const about = make(AboutJugglerContextItem);
      row('about failed', about.getStatusUI({ success: false, error: '9' }, { question: '3' }));
      row('about pending', about.getStatusUI({ pending: true }, { question: '3' }));
      row('about done without a question', about.getStatusUI({ success: true }, {}));

      const source = make(JugglerSourceContextItem);
      row('source failed', source.getStatusUI({ success: false, error: '9' }, { path: '4' }));
      row('source pending', source.getStatusUI({ pending: true }, { path: '4' }));
      row('source done without a path', source.getStatusUI({ success: true }, {}));

      shown['about result label'] = AboutJugglerContextItem.getResultSectionLabel('');
      shown['source result label'] = JugglerSourceContextItem.getResultSectionLabel('');

      const raw = Object.entries(shown).filter(([, s]) => !isPseudoLocalized(s));
      if (raw.length) throw new Error(`plain English under en-XA: ${JSON.stringify(Object.fromEntries(raw))}`);
    }, { '@juggler/about': ABOUT_TEXT });
    passed++;
  } catch (e) {
    failed++;
    errors.push(`en-XA: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { passed, failed, errors };
}
