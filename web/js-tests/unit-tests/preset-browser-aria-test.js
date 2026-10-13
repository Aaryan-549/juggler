//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * ARIA semantics of the system-prompt item's preset browser.
 *
 *   1. The preset dropdown is a named menu. Each preset is a radio item, checked
 *      when it is the one this conversation is on; its "Set default" control is
 *      an item of its own beside it, never nested inside it; the category
 *      captions carry no role, the separator is a separator, and the footer
 *      actions are plain items.
 *   2. The trigger announces the menu and says whether it is open.
 *   3. The manage-presets popup, opened from the menu, is a named dialog: its
 *      rows hold Edit and Delete buttons, which a menu could not.
 * @module unit-tests/preset-browser-aria-test
 */

import { assert } from '../utilities/test-helpers.js';
import { assertMenuShape } from '../utilities/menu-assertions.js';
import { closeAllPopups, __resetPopupManagerForTests } from '../../js/utils/popup-manager.js';
import { systemPromptRegistry } from '../../sdk/lib/system-prompt-registry.js';
import { showPresetBrowser } from '../../extensions/juggler-core/context-items/system-prompt/preset-browser.js';

/**
 * A stand-in for the system-prompt context item: the fields the browser reads.
 * @param {string} selectedPresetId - The preset this conversation is on.
 * @returns {any} The stub item.
 */
function stubItem(selectedPresetId) {
  return {
    data: { text: '', selectedPresetId, isModified: false },
    _dropdownRelease: null,
    _persistData() {},
    _getEffectiveText() { return this.data.text; },
  };
}

/**
 * Run the preset browser ARIA suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Counts and any error messages.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  __resetPopupManagerForTests();
  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:400px;';
  container.innerHTML = '<button class="system-prompt-preset-btn" aria-haspopup="menu" aria-expanded="false">Select a preset</button>';
  document.body.appendChild(container);
  const button = /** @type {HTMLElement} */ (container.querySelector('.system-prompt-preset-btn'));

  const presets = systemPromptRegistry.getCategories().flatMap((c) => systemPromptRegistry.getPresetsByCategory(c));
  const selected = presets[0];
  const item = stubItem(selected?.id ?? '');

  try {
    assert(presets.length > 1, `expected several built-in presets, got ${presets.length}`);
    await showPresetBrowser(item, button, container);
    const surface = document.querySelector('.system-prompt-preset-dropdown');
    const menu = assertMenuShape(surface, 'preset dropdown');
    assert(button.getAttribute('aria-expanded') === 'true', 'the preset button does not say its menu is open');

    const radios = /** @type {HTMLElement[]} */ (Array.from(menu.querySelectorAll('[role="menuitemradio"]')));
    assert(radios.length === presets.length, `expected a radio item per preset (${presets.length}), got ${radios.length}`);
    const checked = radios.filter((r) => r.getAttribute('aria-checked') === 'true');
    assert(checked.length === 1 && (checked[0].getAttribute('aria-label') || checked[0].textContent || '').includes(selected.name),
      `exactly the conversation's preset is checked, got ${JSON.stringify(checked.map((r) => r.textContent))}`);
    assert(radios.every((r) => !r.querySelector('button')), 'a radio item contains a button');
    const setDefault = menu.querySelectorAll('.sp-preset-setdefault-btn');
    assert(setDefault.length > 0 && Array.from(setDefault).every((b) => b.getAttribute('role') === 'menuitem' && !!b.getAttribute('aria-label')),
      'a "Set default" control is not a labelled item of its own');
    const actions = menu.querySelectorAll('.sp-preset-action');
    assert(actions.length === 2 && Array.from(actions).every((a) => a.getAttribute('role') === 'menuitem'),
      'the footer actions are not items');

    // The manage popup is reached from the menu and replaces it.
    const manage = /** @type {HTMLElement} */ (Array.from(actions).find((a) => (a.textContent || '').includes('Manage')));
    manage.click();
    const dialog = document.querySelector('.system-prompt-manage-dropdown');
    assert(!!dialog && dialog.getAttribute('role') === 'dialog' && !!dialog.getAttribute('aria-label'),
      `the manage popup is not a named dialog (role ${JSON.stringify(dialog?.getAttribute('role'))})`);
    closeAllPopups();
    assert(!document.querySelector('.system-prompt-manage-dropdown'), 'the manage popup did not close');
    assert(button.getAttribute('aria-expanded') === 'false', 'the preset button still says open after closing');
    passed++;
  } catch (e) {
    failed++;
    errors.push('preset-browser: ' + (e instanceof Error ? e.message : String(e)));
  } finally {
    closeAllPopups();
    container.remove();
    __resetPopupManagerForTests();
  }

  return { passed, failed, errors };
}
