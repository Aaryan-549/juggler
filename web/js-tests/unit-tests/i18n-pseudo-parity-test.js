//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Pseudo-locale parity: the SDK's pseudoLocalize() (web/sdk/lib/i18n.js) and
 * the Go port that `juggler ext i18n` writes en-XA.json with
 * (msg.PseudoLocalize in cmd/juggler/msg) produce the same text.
 *
 * Both run this ONE fixture (web/js-tests/fixtures/i18n-pseudo-parity.json) —
 * the Go half is TestPseudoParity — so an extension's en-XA.json is the same
 * whichever tool wrote it. This is the JS half.
 * @module unit-tests/i18n-pseudo-parity-test
 */

import { assert } from '../utilities/test-helpers.js';
import { pseudoLocalize } from '../../sdk/lib/i18n.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * @typedef {object} PseudoCase
 * @property {string} name What the case shows, for a failure message.
 * @property {string} message The English message.
 * @property {string} expected Its pseudo-localised text.
 */

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  try {
    const url = new URL('../fixtures/i18n-pseudo-parity.json', import.meta.url);
    const res = await fetch(url);
    assert(res.ok, `failed to fetch the pseudo fixture: HTTP ${res.status}`);
    /** @type {PseudoCase[]} */
    const cases = await res.json();
    assert(Array.isArray(cases) && cases.length > 0, 'the pseudo fixture is empty');

    for (const c of cases) {
      try {
        const got = pseudoLocalize(c.message);
        assert(got === c.expected, `expected ${JSON.stringify(c.expected)}, got ${JSON.stringify(got)}`);
        passed++;
      } catch (/** @type {any} */ e) {
        failed++;
        errors.push(`${c.name}: ${e?.message ?? e}`);
      }
    }
  } catch (/** @type {any} */ e) {
    failed++;
    errors.push(`i18n-pseudo-parity: ${e?.message ?? e}`);
  }

  return { passed, failed, errors };
}
