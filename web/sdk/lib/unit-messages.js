//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The byte-size units shown in the UI, as messages: one place for "12 KB", so
 * every size label a viewer draws translates the same way. The figure arrives
 * already formatted; only the unit and its placement are the message's.
 * @module sdk/lib/unit-messages
 */

import { t } from './i18n.js';

/** The size units, smallest first; a size's tier indexes into this. */
export const SIZE_UNITS = /** @type {const} */ (['B', 'KB', 'MB', 'GB', 'TB']);

/**
 * A formatted figure with its size unit, in the UI language.
 * @param {string} figure - The number, already formatted.
 * @param {typeof SIZE_UNITS[number]} unit
 * @returns {string} E.g. "12 KB".
 */
export function sizeWithUnit(figure, unit) {
  const n = figure;
  switch (unit) {
    case 'B': return t('{n} B', { n });
    case 'KB': return t('{n} KB', { n });
    case 'MB': return t('{n} MB', { n });
    case 'GB': return t('{n} GB', { n });
    default: return t('{n} TB', { n });
  }
}
