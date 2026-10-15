//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests: the text ResponseHandler writes for meta tools, context-item
 * tools and unknown tools.
 *
 * Every one of those strings becomes a tool result the model reads, and the
 * engine follows the UI locale, so under en-XA each must still be the exact
 * English source. The message thread is a stub that records what was stored.
 * @module unit-tests/response-handler-model-text
 */

import { assert } from '../utilities/test-helpers.js';
import { underPseudoLocale } from '../utilities/pseudo-locale.js';
import ResponseHandler from '../../js/services/response-handler.js';

/**
 * A message thread that records each completed tool action.
 * @param {object} overrides - Methods replacing the defaults.
 * @returns {any} The stub, with `completed` holding every completeToolAction call.
 */
function stubThread(overrides = {}) {
  /** @type {any[]} */
  const completed = [];
  return {
    completed,
    completeToolAction(/** @type {string} */ _id, /** @type {any} */ result) { completed.push(result); },
    getContextItem: () => ({}),
    removeContextItem() {},
    executeContextItem: async () => ({ id: '1' }),
    ...overrides,
  };
}

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
   * @param {() => Promise<void>} fn - Test body.
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

  await run('under en-XA every tool result stays English', async () => {
    await underPseudoLocale('response-handler-model-text-test', async () => {
      const rh = new ResponseHandler({ conversation: /** @type {any} */ ({}) });
      /** @type {[string, unknown, string][]} */
      const seen = [];

      const drop = await rh.executeMetaTool({ id: 'a', name: 'drop_context_items', input: { itemIds: ['1', '2'] } }, stubThread());
      seen.push(['drop', drop.content, 'Successfully dropped 2 context items.']);
      const dropOne = await rh.executeMetaTool({ id: 'a', name: 'drop_context_items', input: { itemIds: '3' } }, stubThread());
      seen.push(['drop one', dropOne.content, 'Successfully dropped 1 context item.']);

      const metaThread = stubThread();
      const meta = await rh.executeMetaTool({ id: 'b', name: '9' }, metaThread);
      seen.push(['unknown meta', meta.content, 'Unknown meta tool: 9']);
      seen.push(['unknown meta data', /** @type {any} */ (meta.result)?.error, 'Unknown meta tool: 9']);
      seen.push(['unknown meta stored', metaThread.completed[0]?.content, 'Unknown meta tool: 9']);
      seen.push(['unknown meta fullResult', metaThread.completed[0]?.fullResult?.error, 'Unknown meta tool: 9']);

      const unknownThread = stubThread();
      const unknown = await rh.createUnknownToolResult({ id: 'c', name: '9' }, unknownThread);
      const unknownText = 'Unknown tool: "9". This tool is not registered with any handler.';
      seen.push(['unknown tool', unknown.result, unknownText]);
      seen.push(['unknown tool stored', unknownThread.completed[0]?.content, unknownText]);

      const details = { itemType: '1', class: null };
      const notCreated = await rh.executeContextItem({ id: 'd', name: '1' }, details,
        stubThread({ executeContextItem: async () => ({ created: false }) }));
      seen.push(['item not created', notCreated.content, 'Context item update failed.']);
      seen.push(['item not created error', /** @type {any} */ (notCreated.result)?.error, 'Context item creation failed']);

      const untitled = await rh.executeContextItem({ id: 'e', name: '1' }, details,
        stubThread({ getContextItem: () => ({ getTitle: () => '7' }) }));
      seen.push(['item updated', untitled.content, 'Updated 7']);

      const missingThread = stubThread({ getContextItem: () => null });
      const missing = await rh.executeContextItem({ id: 'f', name: '1' }, details, missingThread);
      const missingText = 'Error: Context item 1 not found after executeContextItem';
      seen.push(['item missing', missing.content, missingText]);
      seen.push(['item missing stored', missingThread.completed[0]?.content, missingText]);

      const wrong = seen.filter(([, got, want]) => got !== want);
      assert(wrong.length === 0, `model-facing text is not the English source under en-XA: ${JSON.stringify(wrong)}`);
    });
  });

  return { passed, failed, errors };
}
