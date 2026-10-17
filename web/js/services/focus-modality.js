//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Focus modality — the focus ring is shown only to someone using the keyboard.
 *
 * `:focus-visible` is meant to say this by itself, but WebKit decides it for a
 * script's `focus()` from the last focus a click made: until a click has
 * focused something, every programmatic focus matches. A button is not
 * focusable by a click on macOS, so at launch nothing has been — and the first
 * control the app focuses for itself (a popup handing focus back to the button
 * that opened it, a dialog focusing its first choice) wears the ring, until the
 * user happens to click into a text field and WebKit's record flips.
 *
 * So the app keeps its own record, on `<html data-input-modality>`: `pointer`
 * from the start and after every pointer press, `keyboard` after any key that
 * is not a bare modifier. While it says `pointer`, `--focus-ring` resolves to
 * nothing (css/base/elements.css), so every ring drawn from that token goes
 * with it. Focus itself is untouched — a keyboard user who presses Tab after a
 * click gets the ring on the very next move.
 * @module services/focus-modality
 */

/** The attribute on the root element that carries the modality. */
export const MODALITY_ATTRIBUTE = 'data-input-modality';

/** Keys that only modify a click or a chord; pressing one alone is not keyboard use. */
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn', 'OS']);

/**
 * Whether an element holds focus the user should see a ring for — focused,
 * matching `:focus-visible`, and reached since the last key rather than since
 * the last click.
 * @param {Element} el - The element to ask about.
 * @returns {boolean} True when focus on it should be shown.
 */
export function isKeyboardFocus(el) {
  const root = el.ownerDocument?.documentElement;
  if (root?.getAttribute(MODALITY_ATTRIBUTE) === 'pointer') return false;
  return typeof el.matches !== 'function' || el.matches(':focus-visible');
}

/**
 * Start tracking the input modality of a document.
 * @param {Document} doc - The document whose root carries the attribute.
 * @returns {() => void} Stops tracking; the attribute is left as it stands.
 */
export function installFocusModality(doc) {
  const root = doc.documentElement;
  /** @param {'pointer'|'keyboard'} modality */
  const set = (modality) => {
    if (root.getAttribute(MODALITY_ATTRIBUTE) !== modality) root.setAttribute(MODALITY_ATTRIBUTE, modality);
  };
  const onPointerDown = () => set('pointer');
  /** @param {KeyboardEvent} e */
  const onKeyDown = (e) => {
    if (!MODIFIER_KEYS.has(e.key)) set('keyboard');
  };

  set('pointer');
  // Capture, so a handler that stops propagation cannot hide the input from it.
  doc.addEventListener('pointerdown', onPointerDown, true);
  doc.addEventListener('keydown', onKeyDown, true);
  return () => {
    doc.removeEventListener('pointerdown', onPointerDown, true);
    doc.removeEventListener('keydown', onKeyDown, true);
  };
}
