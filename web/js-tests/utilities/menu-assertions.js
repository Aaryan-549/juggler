//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The ARIA shape every open menu must have, asserted the same way by every
 * suite that opens one.
 *
 * A menu owns only items, separators and groups. Wrappers with no semantics of
 * their own (`role="none"`) are looked through; any other element in between —
 * an unroled `<menu>`, whose implicit role is `list` — breaks the ownership
 * that makes the rows announce as the menu's items. The items rove: exactly
 * one is in the tab order, which is also how a suite that cannot hold focus
 * (sibling lanes take it) tells that the menu keyboard is attached.
 * @module utilities/menu-assertions
 */

/** Roles an item may carry. */
const ITEM_ROLES = new Set(['menuitem', 'menuitemcheckbox', 'menuitemradio']);

/** Roles that are looked through when checking what the menu owns. */
const TRANSPARENT_ROLES = new Set(['none', 'presentation', 'group']);

/**
 * Throw with `message` unless `cond` holds.
 * @param {boolean} cond - The condition.
 * @param {string} message - What failed.
 */
function check(cond, message) {
  if (!cond) throw new Error(message);
}

/**
 * Describe an element for a failure message.
 * @param {Element} el - The element.
 * @returns {string} Its tag, classes and leading text.
 */
function describe(el) {
  const text = (el.textContent || '').trim().slice(0, 40);
  return `<${el.localName}${el.className ? ` class="${el.className}"` : ''}>${text}`;
}

/**
 * Collect what `parent` owns that is neither an item, a separator, nor looked
 * through.
 * @param {Element} parent - The menu, or a wrapper inside it.
 * @param {string[]} stray - Collected descriptions.
 */
function collectStray(parent, stray) {
  for (const child of Array.from(parent.children)) {
    if (child.getAttribute('aria-hidden') === 'true') continue;
    const role = child.getAttribute('role') || '';
    if (ITEM_ROLES.has(role) || role === 'separator') continue;
    if (TRANSPARENT_ROLES.has(role)) {
      collectStray(child, stray);
      continue;
    }
    stray.push(describe(child));
  }
}

/**
 * Assert a button-opened popover that is not a menu — one that holds fields,
 * toggles or per-row buttons — is a named dialog, and that its trigger says it
 * opens one and that it is open.
 * @param {Element|null} surface - The open popover.
 * @param {Element|null} trigger - The control that opened it.
 * @param {string} label - Assertion label.
 */
export function assertDialogPopover(surface, trigger, label) {
  check(!!surface, `${label}: the popover did not open`);
  const s = /** @type {Element} */ (surface);
  check(s.getAttribute('role') === 'dialog', `${label}: the popover has role ${JSON.stringify(s.getAttribute('role'))}, not "dialog"`);
  check(!!(s.getAttribute('aria-label') || s.getAttribute('aria-labelledby')), `${label}: the dialog has no accessible name`);
  check(!!trigger, `${label}: no trigger`);
  const t = /** @type {Element} */ (trigger);
  check(t.getAttribute('aria-haspopup') === 'dialog',
    `${label}: the trigger does not announce a dialog (aria-haspopup=${JSON.stringify(t.getAttribute('aria-haspopup'))})`);
  check(t.getAttribute('aria-expanded') === 'true',
    `${label}: the trigger does not say the dialog is open (aria-expanded=${JSON.stringify(t.getAttribute('aria-expanded'))})`);
}

/**
 * Assert an open menu's ARIA shape and return the element carrying `role="menu"`.
 * @param {Element|null} root - The menu, or the surface that contains it.
 * @param {string} label - Assertion label.
 * @returns {HTMLElement} The `role="menu"` element.
 */
export function assertMenuShape(root, label) {
  check(!!root, `${label}: the menu did not open`);
  const r = /** @type {Element} */ (root);
  const menus = r.matches('[role="menu"]') ? [r] : Array.from(r.querySelectorAll('[role="menu"]'));
  check(menus.length === 1, `${label}: expected one role="menu", found ${menus.length}`);
  const menu = /** @type {HTMLElement} */ (menus[0]);
  check(!!(menu.getAttribute('aria-label') || menu.getAttribute('aria-labelledby')), `${label}: the menu has no accessible name`);

  /** @type {string[]} */
  const stray = [];
  collectStray(menu, stray);
  check(stray.length === 0, `${label}: the menu owns elements that are not items or separators: ${JSON.stringify(stray)}`);

  const items = /** @type {HTMLElement[]} */ (Array.from(menu.querySelectorAll('[role^="menuitem"]')));
  check(items.length > 0, `${label}: the menu has no items`);
  const stops = items.filter((item) => item.tabIndex === 0);
  const unmanaged = items.filter((item) => item.tabIndex !== 0 && item.tabIndex !== -1);
  // A menu whose every item is disabled has nothing to put in the tab order.
  const live = items.some((item) => item.getAttribute('aria-disabled') !== 'true');
  check((stops.length === (live ? 1 : 0)) && unmanaged.length === 0,
    `${label}: the menu keyboard is not attached (${stops.length} items in the tab order, ${unmanaged.length} unmanaged)`);
  return menu;
}
