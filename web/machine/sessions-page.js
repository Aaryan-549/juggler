//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The sessions page's entry point (web/machine/index.html): wires the page to
 * the machine server's control API and mounts it.
 * @module machine/sessions-page
 */

import { t } from '../sdk/lib/i18n.js';
import { createControlApi, readPageConfig } from './control-api.js';
import { mountSessionsPage } from './sessions-view.js';

/** Title the page and mount it. */
function start() {
  const config = readPageConfig();
  document.title = config.host ? t('Sessions on {host} · Juggler', { host: config.host }) : t('Sessions · Juggler');
  const root = document.getElementById('sessions-root');
  if (root) {
    mountSessionsPage(root, { api: createControlApi({ token: config.token }), config });
  }
}

start();
