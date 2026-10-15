//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests for `<code-block>` (`js/components/code-block.js`): every text it
 * draws on its own — the copy button, its "copied" feedback, the copy-failure
 * alert's title and its right-click menu rows — follows the UI language. The
 * language name in the header and the code itself are data.
 *
 * The clipboard is stubbed both ways (Clipboard API and the legacy
 * execCommand path), and `window.showModal` is stubbed to record the alert.
 * @module unit-tests/code-block-test
 */

import '../../js/components/code-block.js';
import { resolveMenu } from '../../js/services/context-menu-service.js';
import { assert } from '../utilities/test-helpers.js';
import { underPseudoLocale, shownStrings } from '../utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';

/**
 * Make every clipboard write succeed or fail, run `fn`, then put both paths back.
 * @param {boolean} ok
 * @param {() => Promise<void>} fn
 * @returns {Promise<void>}
 */
async function withClipboard(ok, fn) {
  const hadOwn = Object.prototype.hasOwnProperty.call(navigator, 'clipboard');
  const ownDesc = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: () => (ok ? Promise.resolve() : Promise.reject(new Error('1'))) },
  });
  const execCommand = document.execCommand;
  document.execCommand = () => ok;
  try {
    await fn();
  } finally {
    document.execCommand = execCommand;
    if (hadOwn && ownDesc) Object.defineProperty(navigator, 'clipboard', ownDesc);
    else delete /** @type {any} */ (navigator).clipboard;
  }
}

/**
 * Run the code-block test suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  /** @type {string[]} */
  const errors = [];
  let passed = 0;
  let failed = 0;

  /**
   * @param {string} name
   * @param {() => Promise<void>} fn
   */
  const run = async (name, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  await run('everything a code block shows follows the UI language under en-XA', async () => {
    /** @type {string[]} */
    const shown = [];
    const block = document.createElement('code-block');
    block.setAttribute('language', '1');
    block.setAttribute('code', '2');
    // The file path is answered by getAttribute alone, not set as an attribute:
    // a real `[data-file-path]` is also matched by the file-reference provider
    // in properties-panel-helpers.js, which claims the block first whenever it
    // was registered first, and this suite is about the code block's own rows.
    const getAttribute = block.getAttribute.bind(block);
    block.getAttribute = (name) => (name === 'data-file-path' ? '3/4.5' : getAttribute(name));
    const win = /** @type {any} */ (window);
    const showModal = win.showModal;
    /** @type {any[]} */
    const modals = [];
    win.showModal = async (/** @type {any} */ opts) => { modals.push(opts); };
    try {
      await underPseudoLocale('code-block-test', async () => {
        document.body.appendChild(block);
        // The header's language name and the code are data.
        shown.push(...shownStrings(block, '.language, pre'));

        await withClipboard(true, () => /** @type {any} */ (block).copyCode());
        shown.push(...shownStrings(block, '.language, pre'));

        await withClipboard(false, () => /** @type {any} */ (block).copyCode());
        assert(modals.length === 1, `expected one copy-failure alert, got ${modals.length}`);
        shown.push(String(modals[0].title));

        window.getSelection()?.removeAllRanges();
        const menu = resolveMenu(block.querySelector('pre'));
        assert(menu?.subject === block, `the code block's own provider did not claim it (got ${JSON.stringify(menu?.items.map((i) => i.label))})`);
        assert(menu?.items.length === 2, `expected the two copy rows, got ${JSON.stringify(menu?.items.map((i) => i.label))}`);
        for (const item of menu?.items || []) shown.push(String(item.label));
      });
    } finally {
      win.showModal = showModal;
      block.remove();
    }
    assert(shown.length >= 5, `expected at least 5 strings, found ${shown.length}`);
    const raw = shown.filter((s) => !isPseudoLocalized(s));
    assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
  });

  return { passed, failed, errors };
}
