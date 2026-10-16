//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * `<diff-viewer>`'s own words, in every state it draws: loading, the error, each
 * status notice, a diff too large to compute, no changes, both layouts with the
 * layout switch enabled and refused, the hunks' and the diff's spoken labels, the
 * comment anchors, line, file and outdated comments, and its right-click menu.
 * The diff itself — paths, line text, numbers, hunk headers, comment bodies and
 * the error's own text — is data, and is digits throughout so that a translated
 * message around it reads as pseudo text.
 * @module unit-tests/diff-viewer-test
 */

import { assert } from '../utilities/test-helpers.js';
import { underPseudoLocale, shownStrings } from '../utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';
import { SPLIT_MIN_REM, createDiffViewer } from '../../js/components/diff-viewer.js';
import { resolveMenu } from '../../js/services/context-menu-service.js';

/** The viewer's data: everything a translation must leave as it was given. */
const DATA = [
  '.line-num', '.line-prefix', '.line-content', 'diff-stats', 'diff-hunk-header', 'diff-header',
  '.diff-comment-btn', '.diff-comment-body', '.diff-comment-quote', '.diff-notice-detail',
].join(', ');

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label - Test label.
   * @param {() => (void | Promise<void>)} fn - Test body.
   */
  const test = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
  /** @type {HTMLElement[]} */
  const mounted = [];

  /**
   * A viewer in the document, in a box of the given width, with its layout and
   * context set on it alone so the reader's stored defaults are never read.
   * @param {number} width - The box's width, in pixels.
   * @param {boolean} readOnly - Whether it offers comment anchors.
   * @returns {any} The viewer.
   */
  const mount = (width, readOnly) => {
    const box = document.createElement('div');
    box.style.cssText = `position:absolute;left:-9999px;top:0;width:${width}px;`;
    document.body.appendChild(box);
    mounted.push(box);
    const viewer = /** @type {any} */ (createDiffViewer({ readOnly }));
    box.appendChild(viewer);
    viewer.setView('inline');
    viewer.setContextLines(3);
    return viewer;
  };

  try {
    await test('en-XA: every state the viewer draws is translated', async () => {
      /** @type {string[]} */
      const shown = [];
      /**
       * @param {Element} root - What to read.
       * @param {string} where - The state, for the failure.
       */
      const collect = (root, where) => {
        for (const s of shownStrings(root, DATA)) shown.push(`${where}: ${s}`);
      };
      /**
       * The comment anchors' own labels, which skipping their `+` hides.
       * @param {Element} root - What to read.
       * @param {string} where - The state, for the failure.
       */
      const anchors = (root, where) => {
        const buttons = root.querySelectorAll('.diff-comment-btn');
        assert(buttons.length > 0, `expected comment anchors (${where})`);
        for (const b of buttons) {
          shown.push(`${where} anchor: ${b.getAttribute('aria-label') || ''}`);
          shown.push(`${where} anchor title: ${b.getAttribute('title') || ''}`);
        }
      };
      /** @type {string[]} */
      let menu = [];
      let headerFallback = '';

      await underPseudoLocale('diff-viewer-test', async () => {
        // Too narrow for two columns: loading, the error, every notice, and the
        // refused layout switch.
        const narrow = mount(Math.round(SPLIT_MIN_REM * rem / 2), true);
        narrow.setLoading();
        collect(narrow, 'loading');
        narrow.setError(new Error('7'));
        collect(narrow, 'error');
        narrow.setPatch({ path: '1/2.3', oldPath: '4', binary: true, conflicted: true, truncated: true, hunks: [] });
        assert(narrow.querySelector('.diff-view-switch[title]'), 'expected the refused switch to say why');
        collect(narrow, 'notices');
        narrow.setPatch({ path: '1/2.3', hunks: [] });
        assert(narrow.querySelector('diff-no-changes'), 'expected the no-changes note');
        collect(narrow, 'no changes');
        const old = Array.from({ length: 2100 }, (_, i) => `${i}1`).join('\n');
        const now = Array.from({ length: 2100 }, (_, i) => `${i}2`).join('\n');
        narrow.setDiff(old, now, '1/2.3');
        assert(narrow.querySelector('diff-notice[data-kind="large"]'), 'expected the too-large notice');
        collect(narrow, 'too large');

        // Room for two columns, comments offered, and every kind of comment.
        const wide = mount(Math.round(SPLIT_MIN_REM * rem * 1.5), false);
        const hunks = [
          { oldStart: 1, oldLines: 3, newStart: 1, newLines: 2, heading: '9', lines: [
            { kind: 'context', text: '1', oldLine: 1, newLine: 1 },
            { kind: 'remove', text: '2', oldLine: 2 },
            { kind: 'remove', text: '3', oldLine: 3 },
            { kind: 'add', text: '4', newLine: 2 },
          ] },
          { oldStart: 7, oldLines: 0, newStart: 6, newLines: 1, lines: [
            { kind: 'add', text: '5', newLine: 6 },
          ] },
        ];
        wide.setPatch({ path: '1/2.3', oldPath: '4', added: 2, removed: 2, hunks });
        wide.setAnnotations([
          { id: 'a', side: 'old', startLine: 2, endLine: 3, body: '8' },
          { id: 'b', side: 'new', startLine: 2, endLine: 2, body: '8' },
          { id: 'c', side: 'file', body: '8' },
          { id: 'd', side: 'new', startLine: 40, endLine: 40, body: '8', lineText: ['6'] },
        ]);
        assert(wide.querySelector('diff-file-comments .stale'), 'expected an outdated comment');
        collect(wide, 'unified');
        anchors(wide, 'unified');
        wide.setView('split');
        assert(wide.dataset.view === 'split', `expected two columns, got ${wide.dataset.view}`);
        collect(wide, 'split');
        anchors(wide, 'split');

        // No path: the fallbacks in the header and the labels.
        const nameless = mount(Math.round(SPLIT_MIN_REM * rem * 1.5), false);
        nameless.setDiff('1\n2', '1\n3', '');
        nameless.setAnnotations([{ id: 'e', side: 'file', body: '8' }]);
        collect(nameless, 'no path');
        anchors(nameless, 'no path');
        headerFallback = nameless.querySelector('diff-header')?.textContent?.trim() || '';

        // The right-click menu, over a line.
        const line = wide.querySelector('.diff-line');
        assert(line, 'expected a line to right-click');
        const resolved = resolveMenu(line, /** @type {any} */ ({ target: line }));
        assert(resolved?.subject === wide, 'expected the diff viewer to claim its own menu');
        menu = (resolved?.items || []).map((item) => String(item.label));
      });

      assert(menu.length >= 3, `expected the menu's three rows, got ${JSON.stringify(menu)}`);
      shown.push(...menu.map((s) => `menu: ${s}`), `header: ${headerFallback}`);
      const raw = shown.filter((s) => !isPseudoLocalized(s.slice(s.indexOf(': ') + 2)));
      assert(raw.length === 0, `plain English under en-XA (${shown.length} shown): ${JSON.stringify(raw)}`);
    });
  } finally {
    while (mounted.length > 0) mounted.pop()?.remove();
  }

  return { passed, failed, errors };
}
