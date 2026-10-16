//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The viewer bootstrap's own messages to the user: the notice for capability
 * modules a hot reload could not load, and the alert for a conversation the cap
 * will not allow. Kept apart from `app.js`, which boots the whole viewer as it
 * loads, so they can be built and checked on their own.
 * @module services/app-notices
 */

import { showAlert } from '../components/modal-dialog.js';
import { MAX_CONVERSATIONS, CONVERSATION_LIMIT_MESSAGE } from '../model/session.js';
import { t, formatNumber } from '../../sdk/lib/i18n.js';

/**
 * The notice text for capability modules that newly failed to load: each
 * module's file name and its load error, one per line.
 * @param {Array<{path: string, error: string}>} fresh - The newly failed modules (at least one)
 * @returns {string} The notice text
 */
export function failedModulesMessage(fresh) {
  const detail = fresh
    .map(({ path, error }) => `${path.split('/').pop() || path} — ${error}`)
    .join('\n');
  return t('{count, plural, one {Couldn\'t load {detail}} other {Couldn\'t load {count} capability modules\n{detail}}}',
    { count: fresh.length, detail });
}

/**
 * Tell the user a conversation was not created because the cap of
 * open conversations is reached. Every creation path
 * that pre-checks the cap shows this, so the cap reads the same everywhere.
 * @returns {Promise<any>} Resolves when the alert is dismissed
 */
export function showConversationLimitAlert() {
  return showAlert(t(CONVERSATION_LIMIT_MESSAGE, { max: formatNumber(MAX_CONVERSATIONS) }), t('Too many conversations'));
}
