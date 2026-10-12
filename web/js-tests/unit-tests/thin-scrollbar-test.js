//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The thin scrollbar is one rule set, `.u-scrollbar-thin`, worn by the
 * scrollers that want it — the message list and the sidebar's tab list —
 * rather than a copy typed out under each of their own selectors, where the two
 * can only drift apart.
 * @module unit-tests/thin-scrollbar-test
 */

import { assert } from '../utilities/test-helpers.js';
import '../../js/components/conversation-area.js';
import '../../js/components/conversation-bar.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/** The scrollers that wear the shared thin scrollbar, by their own class. */
const WEARERS = ['conversation-message-list', 'conversation-tabs'];

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
 * Whether a rule styles a scrollbar: a `::-webkit-scrollbar*` part, or the
 * standard `scrollbar-*` properties on the scroller itself.
 * @param {CSSStyleRule} rule - The rule.
 * @returns {boolean} True if it does.
 */
function stylesScrollbar(rule) {
  return rule.selectorText.includes('::-webkit-scrollbar')
    || rule.style.getPropertyValue('scrollbar-width') !== ''
    || rule.style.getPropertyValue('scrollbar-color') !== '';
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

  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-9999px;top:0;width:600px;height:400px;';
  document.body.appendChild(host);
  try {
    const area = document.createElement('conversation-area');
    host.appendChild(area);
    const bar = /** @type {any} */ (document.createElement('conversation-bar'));
    host.appendChild(bar);
    // setSession() would spin up per-conversation panels and their workers; the
    // tab list needs none of that, so an empty session is attached directly.
    bar._session = {
      workspaces: [],
      conversations: new Map(),
      bin: { count: 0, sizeBytes: 0 },
      selection: null,
      loadedConversationId: null
    };
    bar.render();

    for (const wearer of WEARERS) {
      check(`.${wearer} wears the shared thin scrollbar`, () => {
        const el = host.querySelector(`.${wearer}`);
        assert(el !== null, `.${wearer} was rendered`);
        assert(el?.classList.contains('u-scrollbar-thin'),
          `.${wearer} carries u-scrollbar-thin, got class="${el?.className}"`);
      });
    }

    const rules = styleRules();

    check('no scroller keeps a thin scrollbar of its own', () => {
      const own = rules
        .filter(rule => WEARERS.some(wearer => rule.selectorText.includes(`.${wearer}`)))
        .filter(stylesScrollbar)
        .map(rule => rule.selectorText);
      assert(own.length === 0, `the shared rule set is the only copy, but these style their own: ${own.join(' | ')}`);
    });

    check('the shared rule set styles the scroller and each scrollbar part', () => {
      const shared = rules
        .filter(rule => rule.selectorText.startsWith('.u-scrollbar-thin'))
        .map(rule => rule.selectorText);
      for (const part of ['::-webkit-scrollbar', '::-webkit-scrollbar-track', '::-webkit-scrollbar-thumb']) {
        assert(shared.includes(`.u-scrollbar-thin${part}`), `a .u-scrollbar-thin${part} rule exists, got ${shared.join(' | ')}`);
      }
      if (CSS.supports('scrollbar-width', 'thin')) {
        const scroller = rules.find(rule => rule.selectorText === '.u-scrollbar-thin');
        assert(scroller?.style.getPropertyValue('scrollbar-width') === 'thin',
          'the scroller itself asks for a thin scrollbar where the engine has the standard property');
      }
    });
  } finally {
    host.remove();
  }

  return { passed, failed, errors };
}
