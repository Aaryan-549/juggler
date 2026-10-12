//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Tests for the change report of a program tool (utils/program-changes.js)
 * and its place in the token estimate (utils/token-estimate.js).
 *
 * The report reaches the model from the worker's wire projection
 * (programChangeReport in cmd/juggler/worker/program_changes.go); this module
 * mirrors it so the UI sizes a program's tool_result as sent. The cases and
 * expected strings are the Go tests' (program_changes_test.go), so a change to
 * either half that the other does not follow fails here or there.
 *
 * Contract under test:
 *   1. Every call that changes things is listed; reads never. Identical
 *      lines merge into the first, with a count.
 *   2. A failed call is marked "(failed)"; any call that did not finish,
 *      "(interrupted)".
 *   3. Fifty lines, then a count of the rest, including effects the record gave up.
 *   4. No record, or a record of reads only, adds nothing.
 *   5. llmTextForItem includes the report, so a cancelled program is sized with it.
 * @module unit-tests/program-change-report-test
 */

import { assert } from '../utilities/test-helpers.js';
import { programChangeReport } from '../../js/utils/program-changes.js';
import { llmTextForItem } from '../../js/utils/token-estimate.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * A plain stand-in for a tool-action Y.Map.
 * @param {Record<string, unknown>} fields - The item's fields
 * @returns {{get: (key: string) => unknown}} The item
 */
const itemOf = (fields) => ({ get: (key) => fields[key] });

/**
 * Run all change-report tests.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Pass/fail counts
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name
   * @param {() => void | Promise<void>} fn
   */
  const test = async (name, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  await test('a cancelled program lists what it changed, the cut-off call interrupted', () => {
    const got = programChangeReport({
      nestedCalls: [
        { name: 'bash', status: 'ok', effect: 'bash: printf done > out.txt' },
        { name: 'read', status: 'ok', args: { file_path: 'a.txt' } },
        { name: 'bash', status: 'cancelled', effect: 'bash: sleep 30' }
      ]
    });
    const want = '\n\nChanges the program made:\n- bash: printf done > out.txt\n- bash: sleep 30 (interrupted)';
    assert(got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  });

  await test('each line says how its call ended', () => {
    const got = programChangeReport({
      nestedCalls: [
        { name: 'edit', status: 'ok', effect: 'edit: src/a.js' },
        { name: 'bash', status: 'error', effect: 'bash: npm test', error: 'exit 1' },
        { name: 'bash', status: 'running', effect: 'bash: make' }
      ]
    });
    const want = '\n\nChanges the program made:\n- edit: src/a.js\n- bash: npm test (failed)\n- bash: make (interrupted)';
    assert(got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  });

  await test('fifty lines, then a count that includes the effects the record gave up', () => {
    const nestedCalls = Array.from({ length: 52 }, (_, i) => ({ name: 'edit', status: 'ok', effect: `edit: f${i}.js` }));
    const got = programChangeReport({ nestedCalls, omittedEffects: 3 });
    assert(got.endsWith('- edit: f49.js\n…and 5 more'), `tail wrong: ${JSON.stringify(got.slice(-60))}`);
    assert(!got.includes('f50.js'), 'listed past the cap');
  });

  await test('repeated changes merge into one line with a count', () => {
    const got = programChangeReport({
      nestedCalls: [
        { name: 'edit', status: 'ok', effect: 'edit: a.js' },
        { name: 'edit', status: 'ok', effect: 'edit: b.js' },
        { name: 'edit', status: 'ok', effect: 'edit: a.js' },
        { name: 'edit', status: 'error', effect: 'edit: a.js' },
        { name: 'bash', status: 'ok', effect: 'bash: make' }
      ]
    });
    const want = '\n\nChanges the program made:\n- edit: a.js (×2)\n- edit: b.js\n- edit: a.js (failed)\n- bash: make';
    assert(got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    const nestedCalls = [
      ...Array.from({ length: 50 }, (_, i) => ({ name: 'edit', status: 'ok', effect: `edit: f${i}.js` })),
      ...Array.from({ length: 3 }, () => ({ name: 'edit', status: 'ok', effect: 'edit: last.js' }))
    ];
    const capped = programChangeReport({ nestedCalls });
    assert(capped.endsWith('- edit: f49.js\n…and 3 more'), `the cut line's changes are counted: ${JSON.stringify(capped.slice(-60))}`);
  });

  await test('no record, or reads only, adds nothing', () => {
    for (const display of [undefined, null, {}, { output: 'partial' }, { nestedCalls: [] },
      { nestedCalls: [{ name: 'read', status: 'ok' }], omitted: 4 }, { nestedCalls: 'not a list' }]) {
      const got = programChangeReport(/** @type {any} */ (display));
      assert(got === '', `displayData ${JSON.stringify(display)} gave ${JSON.stringify(got)}`);
    }
  });

  await test('a cancelled program is sized with its report', () => {
    const toolInput = { code: 'await tools.bash({command: "sleep 30"})' };
    const displayData = { nestedCalls: [{ name: 'bash', status: 'cancelled', effect: 'bash: sleep 30' }] };
    const text = llmTextForItem(itemOf({
      type: 'tool-action',
      toolName: 'program_tool',
      toolInput,
      state: 'cancelled',
      result: { content: 'Interrupted', isError: false },
      displayData
    }));
    const want = JSON.stringify(toolInput) + 'Interrupted' + programChangeReport(displayData);
    assert(text === want, `got ${JSON.stringify(text)}, want ${JSON.stringify(want)}`);
  });

  return { passed, failed, errors };
}
