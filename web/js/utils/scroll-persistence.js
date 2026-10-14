//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Per-conversation scroll-state persistence, in the `device` realm
 * (services/prefs.js): where you had scrolled to is a fact about the screen you
 * were reading on, so it is never shared with another viewer.
 *
 * Stores an element-anchored marker rather than an absolute scrollTop so
 * restore survives changes to content height (added messages, expanded
 * tool actions, resized window). `atBottom` is the fast path: it lets us
 * snap to the live bottom without caring how tall the conversation is now.
 */

import { getDevicePref, setDevicePref } from '../services/prefs.js';

/**
 * @typedef {{atBottom: boolean, topItemId: string|null}} ScrollState
 */

const STORAGE_KEY = 'jugglerScrollStates';

/**
 * @returns {{[conversationId: string]: ScrollState}} All persisted states.
 */
function readAll() {
  const stored = getDevicePref(STORAGE_KEY, {});
  return stored && typeof stored === 'object' ? stored : {};
}

/**
 * @param {string} conversationId
 * @param {ScrollState} state
 */
export function saveScrollState(conversationId, state) {
  const all = readAll();
  all[conversationId] = state;
  setDevicePref(STORAGE_KEY, all);
}

/**
 * @param {string} conversationId
 * @returns {ScrollState|null} Saved state, or null if none persisted.
 */
export function getScrollState(conversationId) {
  const all = readAll();
  return all[conversationId] ?? null;
}
