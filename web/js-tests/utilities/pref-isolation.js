//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Isolating a suite that sets `User` or `Machine` preferences (tips, diff
 * layout) from the stored ones.
 *
 * Those realms live in settings.json, shared by every lane and broadcast to
 * every window, and are mirrored in localStorage, shared by every lane on the
 * origin. A suite that sets one and "restores" it afterwards still writes the
 * shared document twice — and leaves an explicit value where there may have
 * been none. Under isolation a write reaches only this lane's prefs cache and
 * the mirror: the settings PUT is answered here and never sent, and at the end
 * the cache is dropped and the mirror keys put back exactly as they were.
 * @module utilities/pref-isolation
 */

import { __resetPrefsForTests } from '../../js/services/prefs.js';

/** A settings-document request, whatever origin and base path it was built with. */
const SETTINGS_URL = /\/settings(?:\?|$)/;

/**
 * Keep the named preferences' writes to this lane until the returned function
 * is called. Reads still reach the server.
 * @param {string[]} names - The preference names the suite sets.
 * @returns {() => void} Puts the stored state back; call it in a finally.
 */
export function isolatePrefs(names) {
  // A machine preference is mirrored under `<name>@viewer` outside a desktop window.
  const keys = names.flatMap((name) => [name, `${name}@viewer`]);
  const saved = keys.map((key) => /** @type {[string, string|null]} */ ([key, localStorage.getItem(key)]));
  const realFetch = window.fetch;
  window.fetch = /** @type {typeof fetch} */ ((input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = String(init?.method || (input instanceof window.Request ? input.method : 'GET')).toUpperCase();
    if (method !== 'GET' && SETTINGS_URL.test(url)) {
      return Promise.resolve(new window.Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    return realFetch.call(window, input, init);
  });
  return () => {
    // Drops writes still waiting to be sent, and the values this lane cached.
    __resetPrefsForTests();
    window.fetch = realFetch;
    for (const [key, value] of saved) {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    }
  };
}
