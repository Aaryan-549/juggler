//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The focus ring is shown only after keyboard use (services/focus-modality.js):
 * the root's `data-input-modality` starts at `pointer`, follows the last pointer
 * press or non-modifier key, and while it says `pointer` the ring token draws
 * nothing.
 *
 * The suite's document never holds window focus, so a real `:focus-visible`
 * cannot be produced here; the modality, the token it switches and the
 * tooltip's question are checked directly.
 * @module unit-tests/focus-modality-test
 */

import { assert } from '../utilities/test-helpers.js';
import {
  MODALITY_ATTRIBUTE, installFocusModality, isKeyboardFocus,
} from '../../js/services/focus-modality.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/**
 * The outline a probe in the document computes from `var(--focus-ring)`.
 * @returns {string} The computed outline style.
 */
function ringStyle() {
  const probe = document.createElement('div');
  probe.style.setProperty('outline', 'var(--focus-ring)');
  document.body.appendChild(probe);
  const style = getComputedStyle(probe).outlineStyle;
  probe.remove();
  return style;
}

/**
 * @returns {Promise<TestResult>} Aggregated results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name - What is being checked.
   * @param {() => void} body - The check.
   */
  const check = (name, body) => {
    try { body(); passed++; }
    catch (e) { failed++; errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); }
  };

  const root = document.documentElement;
  const before = root.getAttribute(MODALITY_ATTRIBUTE);
  const uninstall = installFocusModality(document);
  const modality = () => root.getAttribute(MODALITY_ATTRIBUTE);
  const key = (/** @type {string} */ k) =>
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  const press = () => document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));

  try {
    check('starts as pointer, before any input', () => {
      assert(modality() === 'pointer', `modality is ${modality()}`);
    });

    check('a key makes it keyboard; a bare modifier does not', () => {
      key('Meta');
      key('Shift');
      assert(modality() === 'pointer', `after modifiers, modality is ${modality()}`);
      key('Tab');
      assert(modality() === 'keyboard', `after Tab, modality is ${modality()}`);
    });

    check('a pointer press makes it pointer again', () => {
      press();
      assert(modality() === 'pointer', `after pointerdown, modality is ${modality()}`);
    });

    check('a handler stopping the key cannot hide it', () => {
      const stop = (/** @type {Event} */ e) => e.stopPropagation();
      document.body.addEventListener('keydown', stop, true);
      try {
        key('ArrowDown');
      } finally {
        document.body.removeEventListener('keydown', stop, true);
      }
      assert(modality() === 'keyboard', `modality is ${modality()}`);
    });

    check('the ring token draws nothing under pointer, and the ring under keyboard', () => {
      root.setAttribute(MODALITY_ATTRIBUTE, 'pointer');
      assert(ringStyle() === 'none', `under pointer the ring is ${ringStyle()}`);
      root.setAttribute(MODALITY_ATTRIBUTE, 'keyboard');
      assert(ringStyle() === 'solid', `under keyboard the ring is ${ringStyle()}`);
    });

    check('focus is never keyboard focus under pointer', () => {
      const button = document.createElement('button');
      root.setAttribute(MODALITY_ATTRIBUTE, 'pointer');
      assert(!isKeyboardFocus(button), 'a button counted as keyboard-focused under pointer');
    });
  } finally {
    uninstall();
    if (before === null) root.removeAttribute(MODALITY_ATTRIBUTE);
    else root.setAttribute(MODALITY_ATTRIBUTE, before);
  }

  return { passed, failed, errors };
}
