//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The server's wording for a provider, as /api/providers publishes it: the
 * English in `description` and `authHint`, and beside each the message it was
 * rendered from (`descriptionMessage`, `authHintMessage`), shown translated
 * where one was sent. Code that overwrites `authHint` locally clears
 * `authHintMessage` with it, or the stale message would win.
 */

import { serverText } from '../../sdk/lib/i18n.js';

/**
 * @typedef {object} ProviderText
 * @property {string} [description] - The provider's blurb, in English.
 * @property {object|null} [descriptionMessage] - The message `description` was rendered from.
 * @property {string} [authHint] - The provider's sign-in state, in English.
 * @property {object|null} [authHintMessage] - The message `authHint` was rendered from.
 */

/**
 * The provider's description, translated where the server sent a message.
 * @param {ProviderText} provider
 * @returns {string} The description, or '' when there is none.
 */
export function providerDescription(provider) {
  return serverText(provider.descriptionMessage, provider.description || '');
}

/**
 * The provider's auth hint, translated where the server sent a message.
 * @param {ProviderText} provider
 * @returns {string} The hint, or '' when there is none.
 */
export function providerAuthHint(provider) {
  return serverText(provider.authHintMessage, provider.authHint || '');
}
