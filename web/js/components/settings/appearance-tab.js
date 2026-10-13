//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   https://juggler.studio
//
//   This program is free software: you can redistribute it and/or modify it under the terms of
//   the GNU Affero General Public License as published by the Free Software Foundation, either
//   version 3 of the License, or (at your option) any later version. This program is distributed
//   in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied
//   warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the LICENSE file or
//   <https://www.gnu.org/licenses/agpl-3.0.html> for full terms.

import { getMode, setMode, MODES, THEME_MODE_EVENT } from '../../utils/theme-manager.js';
import { t, markForTranslation } from '../../../sdk/lib/i18n.js';
import { isDevMode } from '../../services/context-menu-service.js';
import { getUserPref } from '../../services/prefs.js';
import {
  LANGUAGE_PICKER_PREF, UI_LOCALE_CHOICES, chooseUILocale, pageUILocale,
} from '../../services/ui-locale.js';

/**
 * The three modes in menu order. Labels are English source text, translated
 * where the menu is built — a t() here would run once, at import, and never
 * follow the UI language.
 */
const THEME_OPTIONS = [
  { value: MODES.SYSTEM, label: markForTranslation('System') },
  { value: MODES.LIGHT, label: markForTranslation('Light') },
  { value: MODES.DARK, label: markForTranslation('Dark') },
];

/**
 * Appearance tab: the explicit theme mode, and the UI language.
 *
 * The header button is a two-state light switch and never says the word
 * "system" — it picks the mode for you, following the OS unless you ask for the
 * theme the OS isn't showing (see toggleTheme in theme-manager.js). This is
 * where the third mode is offered by name, for choosing what the app should do
 * in future rather than what it should look like right now. Reads straight from
 * the theme-manager (no server fetch) and stays in sync with the header button
 * via THEME_MODE_EVENT.
 *
 * The Language row is built always but shown only in dev mode or when the user
 * preference LANGUAGE_PICKER_PREF is set: no language ships yet, and until one
 * does a normal build must not offer a choice (see services/ui-locale.js).
 */
export class AppearanceTab {
  /**
   * @param {HTMLElement} host - The settings-panel element (DOM query scope).
   */
  constructor(host) {
    /** @type {HTMLElement} @private */
    this.host = host;
    /** @type {((e: Event) => void)|null} @private - Re-syncs the menu when the theme changes elsewhere (the header button, the OS). */
    this._onThemeMode = null;
    /** @type {Promise<void>} - Settles once the Language row's visibility is known. */
    this.languageRowSettled = Promise.resolve();
    /** @type {Promise<void>} - Settles once the last language choice is saved. */
    this.languageSaved = Promise.resolve();
    /** @type {() => void} - Reloads the window into a newly chosen language; a test replaces it. */
    this.reload = () => window.location.reload();
  }

  /** Eager render into the tab's section (called from the shell's render()). */
  render() {
    this.renderAppearanceForm();
  }

  /**
   * Element disconnected: drop the theme listener.
   */
  dispose() {
    if (this._onThemeMode) {
      document.removeEventListener(THEME_MODE_EVENT, this._onThemeMode);
      this._onThemeMode = null;
    }
  }

  /**
   * Render the Appearance tab: the theme mode menu and the language menu.
   * @private
   */
  renderAppearanceForm() {
    const container = this.host.querySelector('#appearance-form');
    if (!container) return;

    container.innerHTML = '';

    const themeRow = this._buildThemeRow(getMode());
    container.appendChild(themeRow.row);
    container.appendChild(this._buildLanguageRow());

    // Keep the menu in step with the header button, which changes the same
    // setting, and with the OS while the mode is System. Registered once;
    // removed in dispose().
    if (!this._onThemeMode) {
      this._onThemeMode = () => {
        themeRow.select.value = getMode();
      };
      document.addEventListener(THEME_MODE_EVENT, this._onThemeMode);
    }
  }

  /**
   * One settings row: a name and description beside a popup menu.
   * @param {{id: string, name: string, description: string, options: ReadonlyArray<{value: string, label: string}>, value: string}} spec
   *   The menu id; the row's name and description, already translated; the options, whose English labels are translated here; and the selection.
   * @returns {{row: HTMLElement, select: HTMLSelectElement}} The row and its menu.
   * @private
   */
  _buildSelectRow({ id, name, description, options, value }) {
    const row = document.createElement('div');
    row.className = 'settings-group provider-field';

    const info = document.createElement('div');
    info.className = 'provider-info';
    const nameEl = document.createElement('div');
    nameEl.className = 'provider-name';
    nameEl.textContent = name;
    const desc = document.createElement('div');
    desc.className = 'provider-description';
    desc.textContent = description;
    info.appendChild(nameEl);
    info.appendChild(desc);

    const ctrl = document.createElement('div');
    ctrl.className = 'provider-control';

    const select = document.createElement('select');
    select.className = 'settings-select field-input';
    select.id = id;
    select.setAttribute('aria-label', name);
    for (const opt of options) {
      const option = document.createElement('option');
      option.value = opt.value;
      option.textContent = t(opt.label);
      select.appendChild(option);
    }
    select.value = value;
    ctrl.appendChild(select);

    row.appendChild(info);
    row.appendChild(ctrl);
    return { row, select };
  }

  /**
   * Build the theme row: a labelled popup menu over the three modes.
   * @param {string} mode - The currently-selected mode (one of MODES).
   * @returns {{row: HTMLElement, select: HTMLSelectElement}} The row and its menu.
   * @private
   */
  _buildThemeRow(mode) {
    const built = this._buildSelectRow({
      id: 'appearance-theme-select',
      name: t('Theme'),
      description: t('Follow the system setting, or hold this app to light or dark. '
        + 'The header button flips between light and dark without coming here.'),
      options: THEME_OPTIONS,
      value: mode,
    });
    built.select.addEventListener('change', () => setMode(built.select.value));
    return built;
  }

  /**
   * Build the language row, hidden until it is known to be wanted: dev mode, or
   * the user preference. Choosing a language saves it and reloads this window
   * into it.
   * @returns {HTMLElement} The row.
   * @private
   */
  _buildLanguageRow() {
    const { row, select } = this._buildSelectRow({
      id: 'appearance-language-select',
      name: t('Language'),
      description: t('The language Juggler is shown in. The window reloads to apply it; '
        + 'other windows follow the next time they open.'),
      options: UI_LOCALE_CHOICES,
      value: pageUILocale(),
    });
    row.id = 'appearance-language-row';
    row.hidden = true;
    select.addEventListener('change', () => {
      this.languageSaved = chooseUILocale(select.value, () => this.reload()).catch((err) => {
        console.error('[Appearance] could not save the UI language:', err);
        select.value = pageUILocale();
      });
    });
    this.languageRowSettled = getUserPref(LANGUAGE_PICKER_PREF, false).then((shown) => {
      row.hidden = !(isDevMode() || shown === true);
    });
    return row;
  }
}
