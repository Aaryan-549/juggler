//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests: every built-in capability's name and description is a message.
 *
 * The Extensions catalogue and the Defaults strategy picker draw a capability's
 * `MANIFEST` name and description through `t()`, scoped to the extension that
 * declares it (its own catalogue, then core's). Those literals sit in a class
 * field, not a `t()` call, so `scripts/i18n extract` must collect them itself.
 * This reads every built-in capability module the server lists and checks the
 * en-XA catalogue the server serves holds each one.
 * @module unit-tests/capability-catalog
 */

import { assert } from '../utilities/test-helpers.js';
import { fetchJson } from '../../js/services/http.js';
import { apiUrl } from '../../js/utils/api-url.js';
import { fetchExtensions } from '../../js/services/extensions.js';
import { importModuleUrl, resolveAssetUrl } from '../../js/utils/asset-url.js';
import { PSEUDO_LOCALE } from '../../sdk/lib/i18n.js';

/** The capability lists whose modules declare a `MANIFEST`. */
const CAPABILITY_LISTS = ['contextItems', 'strategies', 'commands', 'infoCards', 'fileViewers', 'pinboardItems', 'hooks'];

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  try {
    const body = await fetchJson(apiUrl(`/i18n/catalog?locale=${PSEUDO_LOCALE}`));
    const core = body?.messages || {};
    const byExtension = body?.extensions || {};
    const extensions = (await fetchExtensions()).filter((e) => e.source === 'builtin' && !e.error);
    assert(extensions.length > 0, 'no built-in extensions listed');

    /** @type {string[]} */
    const missing = [];
    let checked = 0;
    for (const ext of extensions) {
      const own = byExtension[ext.manifest.id] || {};
      const caps = /** @type {Record<string, any>} */ (ext.capabilities || {});
      for (const list of CAPABILITY_LISTS) {
        for (const url of caps[list] || []) {
          const mod = await importModuleUrl(resolveAssetUrl(url));
          for (const value of Object.values(mod)) {
            const manifest = /** @type {any} */ (value)?.MANIFEST;
            if (!manifest || typeof manifest !== 'object') continue;
            for (const field of ['name', 'description']) {
              const text = manifest[field];
              if (typeof text !== 'string' || !/[A-Za-z]/.test(text)) continue;
              checked++;
              if (!Object.hasOwn(own, text) && !Object.hasOwn(core, text)) {
                missing.push(`${ext.manifest.id} ${manifest.id} ${field}: ${JSON.stringify(text)}`);
              }
            }
          }
        }
      }
    }
    assert(checked > 20, `expected to check the built-in capabilities, checked ${checked}`);
    assert(missing.length === 0, `capability text with no catalogue entry (${missing.length}):\n${missing.join('\n')}`);
    passed++;
  } catch (e) {
    failed++;
    errors.push(`capability-catalog: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { passed, failed, errors };
}
