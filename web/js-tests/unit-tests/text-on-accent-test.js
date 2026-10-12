//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Text on an accent fill — a primary button, an active segment, a preset
 * badge — is one theme token, `--text-on-accent`, rather than a literal white
 * written at each site. Both themes declare it, and no rule spells the colour
 * out itself.
 * @module unit-tests/text-on-accent-test
 */

import { assert } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/**
 * Rules allowed a literal white: the Windows caption close button copies the
 * platform's own control, whose red fill is a literal too.
 */
const ALLOWED = ['.window-caption-btn--close:hover'];

/** A declared colour value that is white written out. */
const LITERAL_WHITE = /^(#fff|#ffffff|white|rgb\(255,\s*255,\s*255\)|rgba\(255,\s*255,\s*255,\s*1\))$/i;

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

  const rules = styleRules();

  check('no rule writes white text out itself', () => {
    const own = rules
      .filter(rule => LITERAL_WHITE.test(rule.style.getPropertyValue('color').trim()))
      .map(rule => rule.selectorText)
      .filter(selector => !ALLOWED.some(allowed => selector.split(',').some(part => part.trim().endsWith(allowed))));
    assert(own.length === 0, `these write white text out: ${own.join(' | ')}`);
  });

  for (const theme of ['dark', 'light']) {
    check(`the ${theme} theme declares --text-on-accent`, () => {
      const declared = rules.some(rule => rule.selectorText.includes(`[data-theme="${theme}"]`)
        && rule.style.getPropertyValue('--text-on-accent').trim() !== '');
      assert(declared, `no [data-theme="${theme}"] rule declares --text-on-accent`);
    });
  }

  check('--text-on-accent resolves on the page', () => {
    const value = getComputedStyle(document.documentElement).getPropertyValue('--text-on-accent').trim();
    assert(value !== '', '--text-on-accent is unset');
  });

  return { passed, failed, errors };
}
