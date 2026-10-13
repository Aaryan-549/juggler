//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * ui-locale — choosing the UI language, and bringing the engine along.
 *
 * The choice is `uiLocale` in the global settings document (settings.json): the
 * person's, not a project's or a window's. A viewer never applies it at
 * runtime. The server writes it into the page with that language's catalogue
 * before the first paint (serveIndex), and web/sdk/lib/i18n.js reads both when
 * it loads — so choosing a language saves it and reloads the window that chose
 * it, and every other window takes it up the next time it loads. Rendering is
 * done once per element throughout the UI, so a live switch would leave the
 * screen half in each language.
 *
 * The engine has no page to be handed anything in, and the same code runs in a
 * webview worker and under Node, so it asks: {@link followUILocale} reads the
 * setting and the catalogues (core and every extension's) over the API and
 * follows the settings broadcast. Extension catalogues in a viewer arrive with
 * the extension list instead (services/extension-catalogs.js).
 * @module services/ui-locale
 */

import { fetchJson } from './http.js';
import wsService from './websocket.js';
import { apiUrl } from '../utils/api-url.js';
import { applyCatalogBody } from './extension-catalogs.js';
import { setLocale, markForTranslation, PSEUDO_LOCALE } from '../../sdk/lib/i18n.js';

/**
 * User preference (settings.json `ui`) that shows the Language row in
 * Settings → Appearance outside dev mode. The row stays hidden otherwise until
 * a language is ready to ship.
 */
export const LANGUAGE_PICKER_PREF = 'juggler-language-picker';

/**
 * The languages the picker offers, in menu order. Labels are English source
 * text, translated where the menu is rendered.
 * @type {ReadonlyArray<{value: string, label: string}>}
 */
export const UI_LOCALE_CHOICES = Object.freeze([
  { value: '', label: markForTranslation('Default (English)') },
  { value: 'en', label: markForTranslation('English') },
  { value: PSEUDO_LOCALE, label: markForTranslation('Pseudo-locale (en-XA)') },
]);

/**
 * The UI language this page was served in: '' for the default.
 * @returns {string} A BCP 47 tag, or ''.
 */
export function pageUILocale() {
  if (typeof document === 'undefined') return '';
  return document.documentElement.getAttribute('data-ui-locale') || '';
}

/**
 * Save the UI language and reload this window into it. Nothing reloads when the
 * page is already in that language.
 * @param {string} locale - A BCP 47 tag, or '' for the default.
 * @param {() => void} [reload] - How to reload; a test passes a spy.
 * @returns {Promise<void>} Resolves once saved (and the reload requested).
 */
export async function chooseUILocale(locale, reload = () => window.location.reload()) {
  await fetchJson(apiUrl('/settings'), { method: 'PUT', body: { uiLocale: locale } });
  if (locale !== pageUILocale()) reload();
}

/** The locale the engine last applied; null before the first. */
let engineLocale = /** @type {string|null} */ (null);

/**
 * Apply a UI language in the engine: fetch its catalogues — core and every
 * extension's — then switch. A later call supersedes one whose fetch is still
 * in flight.
 * @param {string} locale - A BCP 47 tag, or '' for the default.
 * @returns {Promise<void>} Resolves once applied.
 */
async function applyEngineUILocale(locale) {
  const next = locale || '';
  if (next === engineLocale) return;
  engineLocale = next;
  /** @type {any} */
  let body = null;
  if (next) {
    body = await fetchJson(apiUrl(`/i18n/catalog?locale=${encodeURIComponent(next)}`), { fallback: null });
    if (engineLocale !== next) return;
  }
  applyCatalogBody(next, body);
  setLocale(next);
}

/**
 * Take up the UI language in the engine, and follow it when it changes. Call
 * once, at engine start.
 * @returns {Promise<void>} Resolves once the current setting is applied.
 */
export async function followUILocale() {
  wsService.on('settings-changed', (/** @type {any} */ settings) => {
    void applyEngineUILocale(typeof settings?.uiLocale === 'string' ? settings.uiLocale : '');
  });
  const settings = await fetchJson(apiUrl('/settings'), { fallback: null });
  await applyEngineUILocale(typeof settings?.uiLocale === 'string' ? settings.uiLocale : '');
}
