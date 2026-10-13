//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Settings → Notifications: the attention toggles, the chime controls and the
 * Tabs section.
 *
 * Under the en-XA pseudo-locale every word the tab shows — row names and
 * descriptions, the chime menus and their entries, the rotary, the buttons, and
 * their accessible names — must come out accented, in both the desktop-app and
 * the browser wording of the out-of-app signal row.
 *
 * Each toggle's checkbox is tied to its switch by an id that does not depend on
 * the label's language: two rows must never share one, however their names
 * translate.
 * @module unit-tests/notifications-tab-test
 */

import { assert } from '../utilities/test-helpers.js';
import { NotificationsTab, buildToggleRow } from '../../js/components/settings/notifications-tab.js';
import { fetchJson } from '../../js/services/http.js';
import { apiUrl } from '../../js/utils/api-url.js';
import {
  setLocale, registerCatalog, unregisterCatalog, isPseudoLocalized, PSEUDO_LOCALE,
} from '../../sdk/lib/i18n.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed The count of assertions that succeeded.
 * @property {number} failed The count of assertions that threw.
 * @property {string[]} errors The collected failure messages.
 */

/**
 * Render the tab into a fresh host.
 * @returns {{host: HTMLElement, tab: NotificationsTab}} The host and the tab.
 */
function mount() {
  const host = document.createElement('div');
  host.innerHTML = '<div id="notifications-form"></div><div id="tab-behaviour-form"></div>';
  document.body.appendChild(host);
  const tab = new NotificationsTab(host);
  tab.render();
  return { host, tab };
}

/**
 * Every string a host shows: its text nodes, and its accessible names, titles
 * and placeholders.
 * @param {HTMLElement} host
 * @returns {string[]} The strings, trimmed, empty ones dropped.
 */
function shownStrings(host) {
  /** @type {string[]} */
  const shown = [];
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = (n.textContent || '').trim();
    if (text) shown.push(text);
  }
  for (const el of host.querySelectorAll('[aria-label], [title], [placeholder]')) {
    for (const attr of ['aria-label', 'title', 'placeholder']) {
      const v = el.getAttribute(attr);
      if (v) shown.push(v);
    }
  }
  return shown;
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

  await run('toggle ids are unique even when two names share no Latin letters', async () => {
    const a = buildToggleRow('通知', 'x', false, () => {});
    const b = buildToggleRow('声音', 'y', false, () => {});
    assert(a.input.id && b.input.id, 'both checkboxes have an id');
    assert(a.input.id !== b.input.id, `ids collide: ${JSON.stringify(a.input.id)}`);
    const label = a.row.querySelector('label.toggle-switch');
    assert(label && label.getAttribute('for') === a.input.id, 'the switch is tied to its own checkbox');
  });

  await run('under en-XA every visible string is pseudo-localised', async () => {
    const body = await fetchJson(apiUrl(`/i18n/catalog?locale=${PSEUDO_LOCALE}`));
    assert(body && Object.keys(body.messages || {}).length > 0, 'the en-XA catalogue is empty');
    registerCatalog('notifications-tab-test', PSEUDO_LOCALE, body.messages);
    const previous = setLocale(PSEUDO_LOCALE);
    const root = document.documentElement;
    const savedWindowMode = root.dataset.windowMode;
    try {
      // The out-of-app signal row is worded for the desktop app or for a
      // browser; both wordings are checked.
      for (const windowMode of ['1', '']) {
        if (windowMode) root.dataset.windowMode = windowMode;
        else delete root.dataset.windowMode;
        const { host, tab } = mount();
        try {
          const shown = shownStrings(host);
          assert(shown.length >= 20, `expected the tab's text, found ${shown.length} strings`);
          const raw = shown.filter((s) => !isPseudoLocalized(s));
          assert(raw.length === 0, `plain English under en-XA (windowMode ${JSON.stringify(windowMode)}): ${JSON.stringify(raw)}`);
        } finally {
          tab.dispose();
          host.remove();
        }
      }
    } finally {
      if (savedWindowMode === undefined) delete root.dataset.windowMode;
      else root.dataset.windowMode = savedWindowMode;
      setLocale(previous);
      unregisterCatalog('notifications-tab-test');
    }
  });

  return { passed, failed, errors };
}
