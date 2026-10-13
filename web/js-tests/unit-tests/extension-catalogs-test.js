//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Extension translation catalogues reach t() before any extension code runs.
 *
 * Every registry, in the viewer and in the engine, gets the extension list from
 * fetchExtensions() before it imports a single extension module, so that is
 * where each extension's catalogue for the active UI language is registered,
 * under the extension's id. A reload re-reads them, dropping the catalogue of an
 * extension that has gone. With no language chosen nothing is fetched at all.
 *
 * The engine, which follows a language change at runtime, registers the same
 * response through applyCatalogBody — core and extensions together.
 *
 * The backend is a fetch stub: no real extension or catalogue is touched.
 * @module unit-tests/extension-catalogs-test
 */

import { assert } from '../utilities/test-helpers.js';
import { fetchExtensions, resetExtensionsCache } from '../../js/services/extensions.js';
import { applyCatalogBody } from '../../js/services/extension-catalogs.js';
import {
  t, setLocale, getLocale, unregisterCatalog, CORE_NAMESPACE, SOURCE_LOCALE,
} from '../../sdk/lib/i18n.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed The count of assertions that succeeded.
 * @property {number} failed The count of assertions that threw.
 * @property {string[]} errors The collected failure messages.
 */

const MESSAGE = 'Fixture message from an extension';
const PSEUDO = '[Ƒîẋţûŕé ɱéššåĝé ƒŕöɱ åñ éẋţéñšîöñ ·····]';

/**
 * Route window.fetch to a stub extension list and catalogue endpoint.
 * @param {Record<string, Record<string, string>>} extensions - The catalogue response's `extensions`.
 * @returns {{restore: () => void, catalogRequests: string[]}} Restore, and the catalogue URLs asked for.
 */
function installFetch(extensions) {
  const original = window.fetch;
  /** @type {string[]} */
  const catalogRequests = [];
  window.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ init) => {
    const u = String(url);
    if (u.endsWith('/api/extensions')) {
      return { ok: true, json: async () => [{ manifest: { id: '@test/fixture', provides: { i18n: 'i18n' } }, source: 'user', capabilities: {} }] };
    }
    if (u.includes('/api/i18n/catalog')) {
      catalogRequests.push(u);
      return { ok: true, json: async () => ({ locale: 'en-XA', messages: {}, extensions }) };
    }
    return original.call(window, url, init);
  });
  return { restore: () => { window.fetch = original; }, catalogRequests };
}

/**
 * @param {object} _ctx
 * @returns {Promise<TestResult>} Resolves with the aggregated test result.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label
   * @param {() => Promise<void>} fn
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

  /**
   * Run fn under a UI language, then put the page back as it was.
   * @param {string} locale
   * @param {() => Promise<void>} fn
   */
  const under = async (locale, fn) => {
    const previous = setLocale(locale);
    try {
      await fn();
    } finally {
      setLocale(previous);
      unregisterCatalog('@test/fixture');
      resetExtensionsCache();
    }
  };

  await run('the extension list brings each extension\u2019s catalogue with it', () => under('en-XA', async () => {
    const backend = installFetch({ '@test/fixture': { [MESSAGE]: PSEUDO } });
    try {
      resetExtensionsCache();
      await fetchExtensions();
      assert(backend.catalogRequests.length === 1, `catalogue requests: ${JSON.stringify(backend.catalogRequests)}`);
      assert(backend.catalogRequests[0].includes('locale=en-XA'), `asked for ${backend.catalogRequests[0]}`);
      assert(t(MESSAGE) === PSEUDO, `t() gave ${JSON.stringify(t(MESSAGE))}`);
    } finally {
      backend.restore();
    }
  }));

  await run('a reload drops the catalogue of an extension that has gone', () => under('en-XA', async () => {
    let backend = installFetch({ '@test/fixture': { [MESSAGE]: PSEUDO } });
    try {
      resetExtensionsCache();
      await fetchExtensions();
    } finally {
      backend.restore();
    }
    backend = installFetch({});
    try {
      resetExtensionsCache();
      await fetchExtensions();
      assert(t(MESSAGE) === MESSAGE, `still translated after its extension went: ${JSON.stringify(t(MESSAGE))}`);
    } finally {
      backend.restore();
    }
  }));

  await run('with no language chosen no catalogue is fetched', () => under('', async () => {
    const backend = installFetch({ '@test/fixture': { [MESSAGE]: PSEUDO } });
    try {
      resetExtensionsCache();
      await fetchExtensions();
      assert(backend.catalogRequests.length === 0, `fetched ${JSON.stringify(backend.catalogRequests)}`);
      assert(getLocale() === SOURCE_LOCALE, `no language is chosen, got ${JSON.stringify(getLocale())}`);
      assert(t(MESSAGE) === MESSAGE, 'nothing translated');
    } finally {
      backend.restore();
    }
  }));

  await run('the engine registers core and extensions from one response', () => under('en-XA', async () => {
    applyCatalogBody('en-XA', {
      messages: { 'Fixture core message': '[Ƒîẋţûŕé çöŕé ··]' },
      extensions: { '@test/fixture': { [MESSAGE]: PSEUDO } },
    });
    try {
      assert(t('Fixture core message') === '[Ƒîẋţûŕé çöŕé ··]', 'core registered');
      assert(t(MESSAGE) === PSEUDO, 'extension registered');
    } finally {
      unregisterCatalog(CORE_NAMESPACE);
    }
  }));

  return { passed, failed, errors };
}
