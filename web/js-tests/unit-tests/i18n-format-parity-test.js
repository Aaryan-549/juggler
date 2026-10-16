//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Message-format parity: the SDK's formatter (web/sdk/lib/i18n.js) and the
 * server's (cmd/juggler/msg) render one message identically.
 *
 * Both run this ONE fixture (web/js-tests/fixtures/i18n-format-parity.json) —
 * the Go half is TestFormatParity — so a server message the viewer translates
 * reads the same as the English the server rendered for it, and neither
 * formatter can drift without a test failing. This is the JS half. Each case
 * runs through t() and through serverText() given the wire form of the
 * message, under the locale it names (en when it names none) with its
 * catalogue registered in a namespace of the suite's own.
 * @module unit-tests/i18n-format-parity-test
 */

import { assert } from '../utilities/test-helpers.js';
import {
  registerCatalog, unregisterCatalog, setLocale, translator, serverText,
} from '../../sdk/lib/i18n.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * @typedef {object} ParityCase
 * @property {string} name What the case shows, for a failure message.
 * @property {string} template The English template: the key and the fallback.
 * @property {Record<string, unknown>} [params] Values for its placeholders.
 * @property {string} [context] The message's context, if it has one.
 * @property {string} [locale] The UI locale to render in; en when absent.
 * @property {Record<string, string>} [catalog] That locale's catalogue.
 * @property {string} expected The rendered text both formatters must produce.
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
  const NS = 'i18n-format-parity-test';
  const tNS = translator(NS);

  try {
    const url = new URL('../fixtures/i18n-format-parity.json', import.meta.url);
    const res = await fetch(url);
    assert(res.ok, `failed to fetch the parity fixture: HTTP ${res.status}`);
    /** @type {ParityCase[]} */
    const cases = await res.json();
    assert(Array.isArray(cases) && cases.length > 0, 'the parity fixture is empty');

    for (const c of cases) {
      const locale = c.locale || 'en';
      const previous = setLocale(locale);
      try {
        if (c.catalog) registerCatalog(NS, locale, c.catalog);
        const options = c.context ? { context: c.context } : undefined;
        const viaT = tNS(c.template, c.params, options);
        /** @type {{key: string, params?: Record<string, unknown>, context?: string}} */
        const wire = { key: c.template };
        if (c.params) wire.params = c.params;
        if (c.context) wire.context = c.context;
        const viaServerText = serverText(wire, 'fallback');
        assert(viaT === c.expected, `t(): expected ${JSON.stringify(c.expected)}, got ${JSON.stringify(viaT)}`);
        assert(viaServerText === c.expected,
          `serverText(): expected ${JSON.stringify(c.expected)}, got ${JSON.stringify(viaServerText)}`);
        passed++;
      } catch (/** @type {any} */ e) {
        failed++;
        errors.push(`${c.name}: ${e?.message ?? e}`);
      } finally {
        unregisterCatalog(NS);
        setLocale(previous);
      }
    }
  } catch (/** @type {any} */ e) {
    failed++;
    errors.push(`i18n-format-parity: ${e?.message ?? e}`);
  }

  return { passed, failed, errors };
}
