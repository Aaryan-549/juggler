//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * ARIA semantics of the skills tab's "Add source" menu.
 *
 *   1. The trigger announces itself as a menu button (`aria-haspopup="menu"`)
 *      and starts collapsed.
 *   2. The surface is a named `menu` that owns nothing but items and
 *      separators: every row is a `menuitem`, an already-added source a
 *      disabled one, the divider a `separator`, and the "Suggested sources"
 *      heading carries no role of its own.
 *   3. `aria-expanded` follows the menu: true while it is open, false again
 *      after a dismissal through the popup manager and after choosing a row.
 *
 * The suggested rows are the server's compiled-in default sources; the first
 * is marked as already configured so the disabled row is exercised too.
 * @module unit-tests/skills-add-source-menu-aria-test
 */

import { assert } from '../utilities/test-helpers.js';
import { assertMenuShape } from '../utilities/menu-assertions.js';
import { closeAllPopups, __resetPopupManagerForTests } from '../../js/utils/popup-manager.js';
import { fetchDefaultSources } from '../../js/services/skills-registry.js';
import { SkillsTab } from '../../js/components/settings/skills-tab.js';

/** Roles a `menu` may own directly. */
const MENU_CHILD_ROLES = new Set(['menuitem', 'menuitemcheckbox', 'menuitemradio', 'separator', 'group', 'none']);

/**
 * Mount a skills tab on a stub host, its Discover view rendered over a catalog
 * that lists `sourceIds` as configured.
 * @param {string[]} sourceIds - Source ids the catalog reports as configured.
 * @returns {{tab: any, host: HTMLElement}} The controller and its host.
 */
function mountSkillsTab(sourceIds) {
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:640px;height:600px;';
  host.innerHTML = '<div id="skills-tab-root"></div>';
  document.body.appendChild(host);
  const tab = /** @type {any} */ (new SkillsTab(host));
  tab.render();
  tab.catalog = {
    entries: [],
    sources: sourceIds.map((id) => ({ id, label: id, repo: `x/${id}`, trust: 'official', stale: false, entryCount: 0 })),
  };
  tab._renderBody();
  return { tab, host };
}

/**
 * Assert the trigger's menu-button attributes.
 * @param {HTMLElement|null} button - The trigger.
 * @param {'true'|'false'} expanded - The aria-expanded value expected.
 * @param {string} label - Assertion label.
 */
function assertTrigger(button, expanded, label) {
  assert(!!button, `${label}: no trigger button`);
  const b = /** @type {HTMLElement} */ (button);
  assert(b.getAttribute('aria-haspopup') === 'menu',
    `${label}: the trigger does not announce a menu (aria-haspopup=${JSON.stringify(b.getAttribute('aria-haspopup'))})`);
  assert(b.getAttribute('aria-expanded') === expanded,
    `${label}: aria-expanded should be ${expanded}, got ${JSON.stringify(b.getAttribute('aria-expanded'))}`);
}

/**
 * Run the add-source menu ARIA suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Counts and any error messages.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const defaults = await fetchDefaultSources();

  // ── Test 1: roles on the surface and its rows, expanded state on dismissal ──
  {
    __resetPopupManagerForTests();
    const { tab, host } = mountSkillsTab([defaults[0]?.id ?? '']);
    try {
      assert(defaults.length > 1, `expected the server to offer several default sources, got ${defaults.length}`);
      const button = /** @type {HTMLElement|null} */ (host.querySelector('[data-action="add-source"]'));
      assertTrigger(button, 'false', 'closed');

      await tab._openAddSourceMenu(button);
      const menu = /** @type {HTMLElement|null} */ (document.querySelector('.skills-add-source-menu [role="menu"]'));
      assert(!!menu, 'the add-source surface holds no role="menu"');
      const m = /** @type {HTMLElement} */ (menu);
      assert(!!m.getAttribute('aria-label'), 'the menu has no accessible name');
      assertTrigger(button, 'true', 'open');

      const rows = /** @type {HTMLElement[]} */ ([...m.querySelectorAll('.menu-item')]);
      assert(rows.length === defaults.length + 1, `expected ${defaults.length + 1} rows, got ${rows.length}`);
      const unroled = rows.filter((r) => r.getAttribute('role') !== 'menuitem').map((r) => (r.textContent || '').trim());
      assert(unroled.length === 0, `rows without role="menuitem": ${JSON.stringify(unroled)}`);
      const added = rows.filter((r) => r.classList.contains('unavailable'));
      assert(added.length === 1 && added[0].getAttribute('aria-disabled') === 'true',
        'the already-added source is not a single disabled item');
      assert(m.querySelector('.menu-divider')?.getAttribute('role') === 'separator', 'the divider is not a separator');

      const stray = /** @type {HTMLElement[]} */ ([...m.children])
        .filter((c) => !MENU_CHILD_ROLES.has(c.getAttribute('role') || ''))
        .map((c) => `${c.className}: ${(c.textContent || '').trim()}`);
      assert(stray.length === 0, `the menu owns children that are not items or separators: ${JSON.stringify(stray)}`);
      assertMenuShape(m, 'add-source menu');

      closeAllPopups();
      assert(!document.querySelector('.skills-add-source-menu'), 'the dismissed menu is still in the page');
      assertTrigger(button, 'false', 'dismissed');
      passed++;
    } catch (e) {
      failed++;
      errors.push('add-source-roles: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      closeAllPopups();
      host.remove();
    }
  }

  // ── Test 2: choosing a row collapses the trigger ───────────────────────────
  {
    __resetPopupManagerForTests();
    const { tab, host } = mountSkillsTab([]);
    try {
      // The URL row opens a prompt dialog; only the menu's own close is under test.
      tab._promptAddSource = async () => {};
      const button = /** @type {HTMLElement|null} */ (host.querySelector('[data-action="add-source"]'));
      await tab._openAddSourceMenu(button);
      assertTrigger(button, 'true', 'open before choosing');
      const urlRow = /** @type {HTMLElement|null} */ (document.querySelector('.skills-add-source-menu .menu-item'));
      assert(!!urlRow, 'no "Enter a URL…" row to choose');
      /** @type {HTMLElement} */ (urlRow).click();
      assert(!document.querySelector('.skills-add-source-menu'), 'choosing a row left the menu open');
      assertTrigger(button, 'false', 'after choosing');
      passed++;
    } catch (e) {
      failed++;
      errors.push('add-source-choose: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      closeAllPopups();
      host.remove();
    }
  }

  __resetPopupManagerForTests();
  return { passed, failed, errors };
}
