//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { fetchJson, HttpError } from './http.js';
import { apiUrl } from '../utils/api-url.js';
import { markUntranslated } from '../../sdk/lib/i18n.js';

/**
 * Apply semantic edits to one pinboard. This transport is realm-neutral: the
 * viewer store uses it for user edits, and an engine tool can use it without
 * importing the viewer-only pin registry or presentation state. The tool hands
 * a failure's message to the model, so it is written here in English rather
 * than through `fetchJson`'s `errorPrefix`, which is UI text.
 * @param {string} board - Board id.
 * @param {Array<Record<string, any>>} operations - Edits to apply.
 * @param {{pin: string, from?: string}|null} [reveal] - Optional advisory reveal.
 * @param {AbortSignal} [signal] - Cancels the request with its owning action.
 * @returns {Promise<{board?: string, pins?: any[]}>} The server's resulting board.
 */
export async function applyPinboardOperations(board, operations, reveal = null, signal) {
  const body = reveal ? { operations, reveal } : { operations };
  try {
    return await fetchJson(apiUrl(`/session/pinboard/operations?board=${encodeURIComponent(board)}`), {
      method: 'POST',
      body,
      signal,
    });
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    const message = err.detail
      ? `[Pinboard] Operation failed: ${err.detail}`
      : `[Pinboard] Operation failed (HTTP ${err.status})`;
    throw new HttpError(markUntranslated(message), err.status, err.detail, err.body);
  }
}
