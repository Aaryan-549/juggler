//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The settings panel's own shell: the tab strip, the close button, the loading
 * line, and each section's heading and blurb. What a tab renders inside its
 * section is that tab's, and tested with it.
 *
 * Under the en-XA pseudo-locale every word of the shell must come out
 * accented. The credentials path in the Providers blurb is data, not a word.
 * @module unit-tests/settings-panel-test
 */

import { assert } from '../utilities/test-helpers.js';
import { fetchJson } from '../../js/services/http.js';
import { apiUrl } from '../../js/utils/api-url.js';
import {
  setLocale, registerCatalog, unregisterCatalog, isPseudoLocalized, PSEUDO_LOCALE,
} from '../../sdk/lib/i18n.js';
import '../../js/components/settings-panel.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed The count of assertions that succeeded.
 * @property {number} failed The count of assertions that threw.
 * @property {string[]} errors The collected failure messages.
 */

/** The shell's own text: everything the template writes, nothing a tab does. */
const SHELL_TEXT = [
  '.settings-tab',
  '.settings-loading-text',
  '.settings-tab-content > .settings-description',
  '.settings-tab-content > .settings-section-heading',
  '#logs-empty',
  '.logs-picker-label',
].join(', ');

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

  await run('under en-XA every word of the shell is pseudo-localised', async () => {
    const body = await fetchJson(apiUrl(`/i18n/catalog?locale=${PSEUDO_LOCALE}`));
    assert(body && Object.keys(body.messages || {}).length > 0, 'the en-XA catalogue is empty');
    registerCatalog('settings-panel-test', PSEUDO_LOCALE, body.messages);
    const previous = setLocale(PSEUDO_LOCALE);
    const el = document.createElement('settings-panel');
    try {
      document.body.appendChild(el);
      /** @type {string[]} */
      const shown = [];
      for (const node of el.querySelectorAll(SHELL_TEXT)) {
        const copy = /** @type {HTMLElement} */ (node.cloneNode(true));
        copy.querySelectorAll('code').forEach((c) => c.remove());
        const text = (copy.textContent || '').trim();
        if (text) shown.push(text);
      }
      const close = el.querySelector('#settings-close');
      shown.push(close?.getAttribute('title') || '', close?.getAttribute('aria-label') || '');
      assert(shown.length >= 25, `expected the shell's text, found ${shown.length} strings`);
      const raw = shown.filter((s) => !isPseudoLocalized(s));
      assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
      assert(el.querySelector('#credentials-path'), 'the credentials path element is still there to be filled in');
    } finally {
      el.remove();
      setLocale(previous);
      unregisterCatalog('settings-panel-test');
    }
  });

  // The Keyboard shortcuts tab draws the shortcut manager's definitions, whose
  // fields are English source text (the AboutJuggler corpus reads them as they
  // are), so the tab is where they are translated. Keycaps are not words, and
  // the Escape row belongs to escape-behaviour.js.
  await run('under en-XA the shortcut list is pseudo-localised', async () => {
    const body = await fetchJson(apiUrl(`/i18n/catalog?locale=${PSEUDO_LOCALE}`));
    registerCatalog('settings-panel-test', PSEUDO_LOCALE, body?.messages || {});
    const previous = setLocale(PSEUDO_LOCALE);
    const el = document.createElement('settings-panel');
    try {
      document.body.appendChild(el);
      const nodes = el.querySelectorAll('#shortcuts-form > h3, '
        + '#shortcuts-form > .shortcut-row:not(.escape-behaviour-row) :is(.provider-name, .provider-description)');
      const shown = [...nodes].map((n) => (n.textContent || '').trim()).filter(Boolean);
      assert(shown.length >= 40, `expected the shortcut list, found ${shown.length} strings`);
      const raw = shown.filter((s) => !isPseudoLocalized(s));
      assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
    } finally {
      el.remove();
      setLocale(previous);
      unregisterCatalog('settings-panel-test');
    }
  });

  return { passed, failed, errors };
}
