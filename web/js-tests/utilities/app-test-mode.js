//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * What the app page does under the test harness, kept out of the app.
 *
 * A test server's app page loads this module beside app.js (serveIndex,
 * `HarnessPage`); no other server's page names it, and a production build
 * does not carry the js-tests tree at all. The app itself never asks whether
 * it is under test, so a shell a test hosts is the shell a user gets.
 *
 * It does two things:
 * - A top-level page is a pool slot: it polls the queue and navigates to
 *   /headless-test to run whatever is pending. A shell in a frame is one a
 *   browser test is hosting, not a slot, so it takes nothing off the queue.
 * - It publishes the attention manager's test seam as `window.__attention`,
 *   for drivers that reach the page from outside its module graph (demo/).
 * @module utilities/app-test-mode
 */

import { fetchJson } from '../../js/services/http.js';
import { apiUrl, serverPath } from '../../js/utils/api-url.js';
import { __attention } from '../../js/utils/attention-manager.js';

/** @type {any} */ (window).__attention = __attention;

if (window.top === window) {
  setInterval(async () => {
    try {
      const entry = await fetchJson(apiUrl('/test/pending'));
      if (!entry) return; // 204 — nothing queued
      if (entry.name === '__list__') {
        window.location.href = serverPath('/headless-test?list=1');
      } else if (entry.taskId) {
        let url = serverPath('/headless-test') + `?task=${encodeURIComponent(entry.taskId)}&projectPath=${encodeURIComponent(entry.projectPath)}&quiet=true`;
        if (entry.model) url += `&model=${encodeURIComponent(entry.model)}`;
        if (entry.provider) url += `&provider=${encodeURIComponent(entry.provider)}`;
        window.location.href = url;
      } else {
        window.location.href = serverPath('/headless-test') + `?test=${encodeURIComponent(entry.name)}&projectPath=${encodeURIComponent(entry.projectPath)}`;
      }
    } catch (_) { /* ignore fetch errors */ }
  }, 200);
}
