//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * `<diff-viewer>` draws a snapshot asynchronously.
 *
 * Diffing and highlighting two whole files is never done inside `setDiff`: it
 * runs as a job once the viewer is in a document, a viewer that leaves the
 * document or is handed new input before its job starts never pays for it, and
 * a result already computed is reused by any viewer handed the same input. The
 * cases count jobs through `snapshotStats` rather than timing anything, so they
 * say the same on a busy machine as on a quiet one.
 * @module unit-tests/diff-async-test
 */

import { assert } from '../utilities/test-helpers.js';
import { snapshotStats } from '../../js/lib/diff-snapshot-client.js';
import { buildSnapshot } from '../../js/lib/diff-snapshot.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Aggregated test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  await import('../../js/components/diff-viewer.js');

  /** @type {HTMLElement[]} */
  const mounted = [];

  /**
   * @param {string} label - Case name
   * @param {() => Promise<void>} fn - Case body
   */
  const run = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      while (mounted.length > 0) mounted.pop()?.remove();
    }
  };

  /**
   * A viewer in the document, as the properties panel leaves one.
   * @returns {any} The viewer.
   */
  const mountedViewer = () => {
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:-9999px;top:0;width:400px;';
    const el = /** @type {any} */ (document.createElement('diff-viewer'));
    el.setView('inline');
    host.appendChild(el);
    document.body.appendChild(host);
    mounted.push(host);
    return el;
  };

  let unique = 0;
  /**
   * A big file and a one-line edit to it, never seen before by any cache.
   * @returns {{before: string, after: string}} The two sides.
   */
  const bigEdit = () => {
    const tag = `${Date.now()}_${unique++}`;
    const body = Array.from({ length: 3000 }, (_, k) => `const v${k}_${tag} = ${k};`);
    const edited = [...body];
    edited[1500] = `const v1500_${tag} = CHANGED;`;
    return { before: `${body.join('\n')}\n`, after: `${edited.join('\n')}\n` };
  };

  /**
   * @param {HTMLElement} el - A viewer
   * @returns {string[]} The text of each drawn line
   */
  const lineTexts = (el) => [...el.querySelectorAll('.diff-line .line-content')].map((n) => n.textContent || '');

  await run('setDiff draws a pending shell and the hunks arrive later', async () => {
    const el = mountedViewer();
    const { before, after } = bigEdit();
    el.setDiff(before, after, '/src/big.js');
    assert(el.querySelectorAll('.diff-line').length === 0, 'setDiff must not draw rows synchronously');
    assert(el.querySelector('diff-notice[data-kind="loading"]') !== null, 'expected the pending notice');
    assert(el.querySelector('diff-header')?.textContent?.includes('/src/big.js'), 'the header is drawn at once');
    await el.drawn;
    assert(el.querySelector('diff-notice[data-kind="loading"]') === null, 'the pending notice should be gone');
    assert(lineTexts(el).some((t) => t.includes('CHANGED')), `expected the edit, got ${lineTexts(el).join(' / ')}`);
  });

  await run('a viewer removed before its job starts never computes', async () => {
    const start = snapshotStats.computed;
    const gone = mountedViewer();
    const a = bigEdit();
    gone.setDiff(a.before, a.after, '/src/a.js');
    gone.parentElement?.remove();

    const kept = mountedViewer();
    const b = bigEdit();
    kept.setDiff(b.before, b.after, '/src/b.js');
    await kept.drawn;
    assert(snapshotStats.computed - start === 1,
      `only the viewer still showing should compute, got ${snapshotStats.computed - start} jobs`);
  });

  await run('input replaced before its job starts is never computed', async () => {
    const start = snapshotStats.computed;
    const el = mountedViewer();
    const a = bigEdit();
    const b = bigEdit();
    el.setDiff(a.before, a.after, '/src/a.js');
    el.setDiff(b.before, b.after, '/src/b.js');
    await el.drawn;
    assert(snapshotStats.computed - start === 1, `expected one job, got ${snapshotStats.computed - start}`);
    assert(el.querySelector('diff-header')?.textContent?.includes('/src/b.js'), 'the later input is the one drawn');
  });

  await run('the same input handed to a second viewer is not computed again', async () => {
    const { before, after } = bigEdit();
    const first = mountedViewer();
    first.setDiff(before, after, '/src/same.js');
    await first.drawn;
    const start = snapshotStats.computed;
    const second = mountedViewer();
    second.setDiff(before, after, '/src/same.js');
    await second.drawn;
    assert(snapshotStats.computed === start, `a cached result was recomputed ${snapshotStats.computed - start} times`);
    assert(lineTexts(second).join('\n') === lineTexts(first).join('\n'), 'the cached result draws the same rows');
  });

  await run('changing the layout redraws without recomputing', async () => {
    const el = mountedViewer();
    const { before, after } = bigEdit();
    el.setDiff(before, after, '/src/layout.js');
    await el.drawn;
    const start = snapshotStats.computed;
    el.setView('split');
    el.setView('inline');
    assert(lineTexts(el).some((t) => t.includes('CHANGED')), 'a layout change redraws the rows at once');
    assert(snapshotStats.computed === start, 'a layout change must not recompute the diff');
  });

  await run('a detached viewer computes nothing until it is mounted', async () => {
    const start = snapshotStats.computed;
    const el = /** @type {any} */ (document.createElement('diff-viewer'));
    const { before, after } = bigEdit();
    el.setDiff(before, after, '/src/detached.js');
    const other = mountedViewer();
    const b = bigEdit();
    other.setDiff(b.before, b.after, '/src/other.js');
    await other.drawn;
    assert(snapshotStats.computed - start === 1, 'a detached viewer must not compute');
    const host = document.createElement('div');
    document.body.appendChild(host);
    mounted.push(host);
    host.appendChild(el);
    await el.drawn;
    assert(lineTexts(el).some((t) => t.includes('CHANGED')), 'mounting it draws the diff');
  });

  await run('the off-thread result is the in-thread result', async () => {
    const before = 'const a = 1;\n/* one\n   two */\nconst b = 2;\n';
    const after = 'const a = 1;\n/* one\n   two */\nconst b = 3;\n';
    const offThread = snapshotStats.offThread;
    const el = mountedViewer();
    el.setDiff(before, after, `/src/same-${unique++}.js`);
    await el.drawn;
    assert(snapshotStats.offThread === offThread + 1, 'the job should have run in the diff worker');
    const local = buildSnapshot({ oldContent: before, newContent: after, filePath: '/src/x.js', startLineNumber: 1, contextLines: 3 });
    const markup = (local.hunks || []).flatMap((h) => h.lines.map((l) => l.markup ?? ''));
    const drawn = [...el.querySelectorAll('.diff-line .line-content')].map((n) => n.innerHTML);
    assert(markup.some((m) => m.includes('token')), 'the in-thread snapshot should be highlighted');
    assert(JSON.stringify(drawn) === JSON.stringify(markup),
      `drawn markup differs from the in-thread snapshot:\n${JSON.stringify(drawn)}\n${JSON.stringify(markup)}`);
  });

  return { passed, failed, errors };
}
