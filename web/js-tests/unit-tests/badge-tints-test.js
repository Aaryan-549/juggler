//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * A tinted badge — a pale wash of a colour behind text in that colour — is one
 * of six shared tints, `.tint-{blue,green,red,orange,purple,neutral}`
 * (patterns/tints.css), each a `color-mix()` of a theme token so it follows the
 * theme. The plugin catalog and the skills marketplace badges wear them,
 * rather than each spelling out a tint of its own: several were the dark
 * theme's colour written as a literal, so the light theme drew the dark one.
 * @module unit-tests/badge-tints-test
 */

import { assert } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/** The badge rules that once carried a tone of their own, and must not again. */
const BADGES = [
  '.tool-category-read', '.tool-category-write',
  '.ext-source-builtin', '.ext-source-user',
  '.ext-cap-type-context-item', '.ext-cap-type-strategy', '.ext-cap-type-command',
  '.ext-cap-status-disabled', '.ext-cap-status-failed',
  '.plugin-author', '.permission-badge', '.tool-param-optional',
  '.skills-badge.scripts', '.skills-badge.loaded', '.skills-badge.error', '.skills-badge.shadow'
];

/** Each tint, and the token it is a wash of. */
const TINTS = {
  blue: '--accent-blue',
  green: '--accent-green',
  red: '--accent-red',
  orange: '--accent-orange',
  purple: '--accent-purple',
  neutral: '--text-tertiary'
};

/**
 * Every style rule the page carries, from every stylesheet it loaded, layers
 * and media blocks included.
 * @returns {CSSStyleRule[]} The rules, in the order the sheets declare them.
 */
function styleRules() {
  /** @type {CSSStyleRule[]} */
  const found = [];
  /** @param {CSSRuleList} rules */
  const walk = (rules) => {
    for (const rule of rules) {
      const grouped = /** @type {CSSGroupingRule} */ (rule).cssRules;
      if (grouped) walk(grouped);
      if (/** @type {CSSStyleRule} */ (rule).selectorText) found.push(/** @type {CSSStyleRule} */ (rule));
    }
  };
  for (const sheet of document.styleSheets) {
    try {
      walk(sheet.cssRules);
    } catch {
      // A sheet from another origin refuses to be read; the app's own are same-origin.
    }
  }
  return found;
}

/**
 * The computed colours a probe gets for a declared background and text colour.
 * @param {string} background - A CSS background colour.
 * @param {string} color - A CSS colour.
 * @returns {{background: string, color: string}} As the engine computes them.
 */
function computed(background, color) {
  const probe = document.createElement('span');
  probe.style.backgroundColor = background;
  probe.style.color = color;
  document.body.appendChild(probe);
  const style = getComputedStyle(probe);
  const result = { background: style.backgroundColor, color: style.color };
  probe.remove();
  return result;
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

  check('no badge paints a tone of its own', () => {
    const own = styleRules()
      .filter(rule => BADGES.some(badge => rule.selectorText.split(',').some(part => part.trim().endsWith(badge))))
      .filter(rule => rule.style.getPropertyValue('background') !== ''
        || rule.style.getPropertyValue('background-color') !== ''
        || rule.style.getPropertyValue('color') !== '')
      .map(rule => rule.selectorText);
    assert(own.length === 0, `these still paint a tone themselves: ${own.join(' | ')}`);
  });

  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-9999px;top:0;';
  document.body.appendChild(host);
  try {
    for (const [tint, token] of Object.entries(TINTS)) {
      check(`.tint-${tint} is a wash of ${token} behind text in ${token}`, () => {
        // Inside the catalog's own badge, so a component rule that still
        // painted the badge would show here.
        host.innerHTML = `<span class="plugin-badge tint-${tint}">x</span>`;
        const style = getComputedStyle(/** @type {HTMLElement} */ (host.firstElementChild));
        const want = computed(`color-mix(in srgb, var(${token}) 15%, transparent)`, `var(${token})`);
        assert(style.backgroundColor === want.background, `background ${want.background}, got ${style.backgroundColor}`);
        assert(style.color === want.color, `colour ${want.color}, got ${style.color}`);
      });
    }
  } finally {
    host.remove();
  }

  return { passed, failed, errors };
}
