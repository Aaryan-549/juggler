//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * `formatTimeAgo` (web/js/utils/format.js): the short "N ago" label. Its
 * English is fixed wording — "5 min ago", "2 hrs ago" — not whatever
 * `Intl.RelativeTimeFormat`'s short style happens to say ("5 min. ago",
 * "2 hr. ago"), and under another language it is a message like any other, so
 * a catalogue translates it.
 * @module unit-tests/format-time-ago-test
 */

import { assert } from '../utilities/test-helpers.js';
import { formatTimeAgo } from '../../js/utils/format.js';
import { setLocale, registerCatalog, unregisterCatalog, PSEUDO_LOCALE, pseudoLocalize } from '../../sdk/lib/i18n.js';

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated results
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label
   * @param {() => void} fn
   */
  const run = (label, fn) => {
    try {
      fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const MIN = 60000;
  const ago = (/** @type {number} */ ms) => formatTimeAgo(Date.now() - ms);

  for (const locale of ['', 'en', 'en-GB']) {
    run(`English wording (${locale || 'no locale'})`, () => {
      const previous = setLocale(locale);
      try {
        const cases = [
          [10 * 1000, 'just now'],
          [MIN, '1 min ago'],
          [5 * MIN, '5 min ago'],
          [60 * MIN, '1 hr ago'],
          [2 * 60 * MIN, '2 hrs ago'],
          [24 * 60 * MIN, '1 day ago'],
          [3 * 24 * 60 * MIN, '3 days ago'],
        ];
        for (const [ms, want] of cases) {
          const got = ago(/** @type {number} */ (ms));
          assert(got === want, `${ms}ms: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
        }
        assert(formatTimeAgo(0) === '', 'a falsy timestamp is blank');
      } finally {
        setLocale(previous);
      }
    });
  }

  run('a catalogue translates it', () => {
    const NS = 'format-time-ago-test';
    const sources = [
      '{count, plural, one {# min ago} other {# min ago}}',
      '{count, plural, one {# hr ago} other {# hrs ago}}',
      '{count, plural, one {# day ago} other {# days ago}}',
    ];
    registerCatalog(NS, PSEUDO_LOCALE, Object.fromEntries(sources.map((s) => [s, pseudoLocalize(s)])));
    const previous = setLocale(PSEUDO_LOCALE);
    try {
      for (const ms of [5 * MIN, 2 * 60 * MIN, 3 * 24 * 60 * MIN]) {
        const got = ago(ms);
        assert(/\d/.test(got) && !/[A-Za-z]/.test(got), `${ms}ms should be pseudo-localised, got ${JSON.stringify(got)}`);
      }
    } finally {
      setLocale(previous);
      unregisterCatalog(NS);
    }
  });

  return { passed, failed, errors };
}
