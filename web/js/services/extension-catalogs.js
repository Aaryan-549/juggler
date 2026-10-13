//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * extension-catalogs — registering each extension's UI translations.
 *
 * An extension ships catalogues in the directory its manifest names as
 * `provides.i18n`; the server merges the ones along a UI language's chain and
 * returns the result by extension id from `GET /api/i18n/catalog`, beside the
 * core catalogue. Each is registered under its extension's id as the namespace:
 * the extension's own text (`translator(id)`, and the manifest text the host
 * shows) looks there first, while unscoped text looks in core first, so no
 * extension catalogue re-words the core UI (see lookup in sdk/lib/i18n.js).
 *
 * Two callers, so that extension code never renders before its catalogue is in:
 * `fetchExtensions()` (services/extensions.js), which every registry awaits
 * before importing an extension module, in the viewer and in the engine alike;
 * and the engine's language follower (services/ui-locale.js), which registers
 * core and extensions together when the language changes.
 * @module services/extension-catalogs
 */

import { fetchJson } from './http.js';
import { apiUrl } from '../utils/api-url.js';
import {
  getLocale, registerCatalog, unregisterCatalog, CORE_NAMESPACE, SOURCE_LOCALE,
} from '../../sdk/lib/i18n.js';

/** Extension ids whose catalogues are registered now, so a reload can drop them. */
const registered = new Set();

/**
 * Replace the registered extension catalogues with these.
 * @param {string} locale - The language they are in; '' to clear them all.
 * @param {Record<string, Record<string, string>>|null|undefined} extensions - Messages by extension id.
 * @returns {void}
 */
function applyExtensionCatalogs(locale, extensions) {
  for (const id of registered) unregisterCatalog(id);
  registered.clear();
  if (!locale || !extensions || typeof extensions !== 'object') return;
  for (const [id, messages] of Object.entries(extensions)) {
    if (id === CORE_NAMESPACE || !messages || typeof messages !== 'object') continue;
    registerCatalog(id, locale, messages);
    registered.add(id);
  }
}

/**
 * Register a whole `/i18n/catalog` response — core first, then each extension —
 * replacing whatever was registered for them before. For the engine, which has
 * no page catalogue and follows a language change at runtime.
 * @param {string} locale - The language the response is for; '' for none.
 * @param {{messages?: Record<string, string>, extensions?: Record<string, Record<string, string>>}|null} body
 * @returns {void}
 */
export function applyCatalogBody(locale, body) {
  unregisterCatalog(CORE_NAMESPACE);
  const messages = body && typeof body.messages === 'object' ? body.messages : null;
  if (locale && messages) registerCatalog(CORE_NAMESPACE, locale, messages);
  applyExtensionCatalogs(locale, body?.extensions);
}

/**
 * Fetch and register the extensions' catalogues for the active UI language,
 * replacing the ones registered before (an extension may have come or gone).
 * Nothing is fetched while the UI is in English. A failed fetch leaves
 * extension text in English rather than failing the load.
 * @returns {Promise<void>} Resolves once registered.
 */
export async function loadExtensionCatalogs() {
  const locale = getLocale();
  if (locale === SOURCE_LOCALE) {
    applyExtensionCatalogs('', null);
    return;
  }
  const body = await fetchJson(apiUrl(`/i18n/catalog?locale=${encodeURIComponent(locale)}`), { fallback: null });
  // The language changed while the request was out: the newer load wins.
  if (getLocale() !== locale) return;
  applyExtensionCatalogs(locale, body?.extensions);
}
