//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * ARIA for a text field's suggestion list — an autocomplete, which is not a
 * menu. Focus never leaves the field while it is open, because typing is what
 * drives it, so the list is a named `listbox` of `option`s that the field
 * points at (`aria-controls`), and the highlighted row is announced through the
 * field's `aria-activedescendant` instead of by moving focus.
 * @module utils/listbox-roles
 */

/** Makes each list's id, and so each option's, unique in the document. */
let nextListId = 0;

/**
 * Give a freshly built suggestion list its roles: a named `listbox` whose
 * `.menu-item` rows are `option`s, none selected yet. A row that is only there
 * to say nothing matched is a disabled option.
 * @param {HTMLElement} list - The element that directly holds the rows.
 * @param {string} label - Its accessible name.
 */
export function applyListboxRoles(list, label) {
  list.id = `suggestions-${++nextListId}`;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', label);
  list.querySelectorAll('.menu-item').forEach((row, i) => {
    row.id = `${list.id}-${i}`;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', 'false');
    if (row.classList.contains('menu-item-empty')) row.setAttribute('aria-disabled', 'true');
  });
}

/**
 * Point the field at its open list, or — given null — take every trace of the
 * list off it. A field with `role="combobox"` also says whether its list shows.
 * @param {HTMLElement} field - The text field the user types in.
 * @param {HTMLElement|null} list - The open listbox, or null once it has closed.
 */
export function linkListbox(field, list) {
  if (list) {
    field.setAttribute('aria-controls', list.id);
  } else {
    field.removeAttribute('aria-controls');
    field.removeAttribute('aria-activedescendant');
  }
  if (field.getAttribute('role') === 'combobox') field.setAttribute('aria-expanded', String(!!list));
}

/**
 * Announce the highlighted row: mark it selected, and name it as the field's
 * active descendant. An index outside the rows clears both.
 * @param {HTMLElement} field - The text field the user types in.
 * @param {HTMLElement} list - The open listbox.
 * @param {number} index - The highlighted row, or -1 for none.
 */
export function setActiveOption(field, list, index) {
  /** @type {Element|undefined} */
  let active;
  list.querySelectorAll('[role="option"]').forEach((option, i) => {
    option.setAttribute('aria-selected', String(i === index));
    if (i === index) active = option;
  });
  if (active) field.setAttribute('aria-activedescendant', active.id);
  else field.removeAttribute('aria-activedescendant');
}
