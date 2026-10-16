//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The viewer bootstrap's messages to the user (`services/app-notices.js`, shown
 * by `app.js` and the conversation bar): the notice for capability modules a
 * hot reload could not load, and the alert for the conversation cap. Each must
 * read as before in English and follow the UI language, with the module names,
 * load errors and the cap carried through as data.
 * @module unit-tests/app-messages-test
 */

import { assert } from '../utilities/test-helpers.js';
import { underPseudoLocale } from '../utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';
import { failedModulesMessage, showConversationLimitAlert } from '../../js/services/app-notices.js';
import { MAX_CONVERSATIONS } from '../../js/model/session.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * Show the conversation-cap alert with `window.showModal` stubbed, and return
 * what it would have drawn.
 * @returns {Promise<{title: string, message: string}[]>} Every modal asked for
 */
async function captureLimitAlert() {
  const win = /** @type {any} */ (window);
  const origModal = win.showModal;
  /** @type {{title: string, message: string}[]} */
  const shown = [];
  win.showModal = async (/** @type {any} */ options) => {
    shown.push({ title: options.title, message: options.message });
    return null;
  };
  try {
    await showConversationLimitAlert();
  } finally {
    win.showModal = origModal;
  }
  return shown;
}

/** One module, and two: the two shapes the notice takes. Digit-only, so they read as data under en-XA. */
const ONE = [{ path: '7/1', error: '2' }];
const TWO = [{ path: '7/1', error: '2' }, { path: '7/3', error: '4' }];

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Aggregated test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label
   * @param {() => Promise<void>} fn
   */
  const run = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  await run('English: the notices read as they always have', async () => {
    const one = failedModulesMessage(ONE);
    assert(one === 'Couldn\'t load 1 — 2', `one module: got ${JSON.stringify(one)}`);
    const two = failedModulesMessage(TWO);
    assert(two === 'Couldn\'t load 2 capability modules\n1 — 2\n3 — 4', `two modules: got ${JSON.stringify(two)}`);
    const shown = await captureLimitAlert();
    assert(shown.length === 1, `expected one alert; got ${shown.length}`);
    assert(shown[0].title === 'Too many conversations', `alert title: got ${JSON.stringify(shown[0].title)}`);
    const expected = `You can have at most ${MAX_CONVERSATIONS} conversations open at once. Bin some tabs to make room for new ones.`;
    assert(shown[0].message === expected, `alert message: got ${JSON.stringify(shown[0].message)}`);
  });

  await run('en-XA: the failed-module notice and the conversation-cap alert are translated', async () => {
    /** @type {string[]} */
    let one = [];
    /** @type {string[]} */
    let two = [];
    /** @type {{title: string, message: string}[]} */
    let alerts = [];
    await underPseudoLocale('app-messages-test', async () => {
      one = [failedModulesMessage(ONE)];
      two = [failedModulesMessage(TWO)];
      alerts = await captureLimitAlert();
    });
    assert(alerts.length === 1, `expected one alert; got ${alerts.length}`);
    /** @type {string[]} */
    const problems = [];
    if (!one[0].includes('1 — 2')) problems.push(`one-module notice lost its detail: ${JSON.stringify(one[0])}`);
    if (!two[0].includes('2') || !two[0].includes('1 — 2\n3 — 4')) {
      problems.push(`two-module notice lost its count or detail: ${JSON.stringify(two[0])}`);
    }
    if (!alerts[0].message.includes(String(MAX_CONVERSATIONS))) {
      problems.push(`the alert lost the cap: ${JSON.stringify(alerts[0].message)}`);
    }
    const shown = [one[0], two[0], alerts[0].title, alerts[0].message];
    const raw = shown.filter((s) => !isPseudoLocalized(s));
    if (raw.length > 0) problems.push(`plain English under en-XA: ${JSON.stringify(raw)}`);
    assert(problems.length === 0, problems.join('; '));
  });

  return { passed, failed, errors };
}
