//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests: the transcript rows of the plugins that hand `buildStatusUI` (or
 * `resolveTerminalStatus`) a failure prefix, under en-XA.
 *
 * The prefix is drawn inside core's `{prefix}: {error}`, so it must be
 * translated text; the error is the model's and is shown as given. Every other
 * row state and type name these plugins draw is checked too. Inputs and errors
 * are digits, so they read as data inside a message.
 * @module unit-tests/status-row-prefixes-test
 */

import { underPseudoLocale } from '../../../js-tests/utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../../sdk/lib/i18n.js';
import BatchContextItem from '../context-items/batch-context-item.js';
import GlobContextItem from '../context-items/glob-context-item.js';
import QueryCodeContextItem from '../context-items/query-code-context-item.js';
import SearchContextItem from '../context-items/search-context-item.js';
import TaskOutputContextItem from '../context-items/task-output-context-item.js';
import TaskStopContextItem from '../context-items/task-stop-context-item.js';
import WebFetchContextItem from '../context-items/web-fetch-context-item.js';
import NewConversationContextItem from '../context-items/new-conversation-context-item.js';

/** juggler-core's English for these rows, standing in for its catalogue. */
const CORE_TEXT = [
  'BatchRead', 'BatchGrep', '{count} files...', '{count} searches...',
  '{count} files completed', '{count} searches completed', 'failed',
  'Glob', '{count, plural, one {{count} file matching {pattern}} other {{count} files matching {pattern}}}',
  'Script', 'Running…',
  'Grep', '{pattern} in {path}...', '{pattern} in {path}',
  '{pattern} in {path} ({matchCount} matches in {fileCount} files)',
  '{pattern} ({matchCount} matches in {fileCount} files)', 'failed in {path}',
  'TaskOutput', 'Reading output of {taskId}...', 'Read output of {taskId}', 'Failed to read task output',
  'TaskStop', 'Stopping {taskId}...', 'Stopped {taskId}', 'Failed to stop task',
  'Web Fetch', 'Fetching {url}...', 'Redirect to: {url}', '{url} (cached)', '{url} (truncated)',
  '{url} (cached) (truncated)', 'Failed',
  'New Conversation', 'created conversation', 'Creating…', 'New conversation', 'Untitled conversation',
  'Failed to create conversation',
];

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated results
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const session = { platform: 'darwin', home: '/1', projectPath: '/2' };
  const messageThread = { getAllowedPaths: () => ['/2'], getRulesFor: () => [], items: [] };
  /**
   * @param {any} Cls
   * @returns {any} A plugin instance on stub session/conversation/thread.
   */
  const make = (Cls) => new Cls({ id: 'x', session, conversation: { id: 'c', session }, messageThread });

  const pending = { pending: true };
  const failure = { success: false, error: '9' };
  /**
   * @param {any} result
   * @returns {any} A successful action status carrying `result`.
   */
  const ok = (result) => ({ success: true, result });

  try {
    await underPseudoLocale('status-row-prefixes-test', async () => {
      /** @type {Record<string, string>} */
      const shown = {};
      /**
       * Record a row's summary and type name.
       * @param {string} name
       * @param {any} ui
       */
      const row = (name, ui) => {
        shown[`${name} row`] = String(ui?.summary);
        shown[`${name} type name`] = String(ui?.typeName);
      };

      const batch = make(BatchContextItem);
      const reads = { files: [{ file_path: '/2/3' }] };
      const greps = { searches: [{ pattern: '4' }] };
      row('batch read failed', batch.getStatusUI(failure, reads));
      row('batch read pending', batch.getStatusUI(pending, reads));
      row('batch read done', batch.getStatusUI(ok({}), reads));
      row('batch grep failed', batch.getStatusUI(failure, greps));
      row('batch grep pending', batch.getStatusUI(pending, greps));
      row('batch grep done', batch.getStatusUI(ok({}), greps));

      const glob = make(GlobContextItem);
      row('glob failed', glob.getStatusUI(failure, { pattern: '5' }));
      row('glob one', glob.getStatusUI(ok({ count: 1 }), { pattern: '5' }));
      row('glob many', glob.getStatusUI(ok({ count: 2 }), { pattern: '5' }));

      const query = make(QueryCodeContextItem);
      row('query code failed', query.getStatusUI(failure, {}));
      row('query code pending', query.getStatusUI(pending, {}));

      const search = make(SearchContextItem);
      row('search failed', search.getStatusUI(failure, { pattern: '6' }));
      row('search failed in path', search.getStatusUI(failure, { pattern: '6', path: '/7' }));
      row('search pending in path', search.getStatusUI(pending, { pattern: '6', path: '/7' }));
      row('search done', search.getStatusUI(ok({ matchCount: 1, fileCount: 2 }), { pattern: '6' }));
      row('search done in path', search.getStatusUI(ok({ matchCount: 1, fileCount: 2 }), { pattern: '6', path: '/7' }));
      row('search no result in path', search.getStatusUI(ok(undefined), { pattern: '6', path: '/7' }));

      const output = make(TaskOutputContextItem);
      row('task output failed', output.getStatusUI(failure, { task_id: '8' }));
      row('task output pending', output.getStatusUI(pending, { task_id: '8' }));
      row('task output done', output.getStatusUI(ok({}), { task_id: '8' }));

      const stop = make(TaskStopContextItem);
      row('task stop failed', stop.getStatusUI(failure, { task_id: '8' }));
      row('task stop pending', stop.getStatusUI(pending, { task_id: '8' }));
      row('task stop done', stop.getStatusUI(ok({}), { task_id: '8' }));

      const fetch = make(WebFetchContextItem);
      const url = { url: '10' };
      row('web fetch failed', fetch.getStatusUI(failure, url));
      row('web fetch pending', fetch.getStatusUI(pending, url));
      row('web fetch redirect', fetch.getStatusUI(ok({ redirect: true, redirect_url: '11' }), url));
      row('web fetch cached', fetch.getStatusUI(ok({ cached: true }), url));
      row('web fetch truncated', fetch.getStatusUI(ok({ truncated: true }), url));
      row('web fetch cached truncated', fetch.getStatusUI(ok({ cached: true, truncated: true }), url));

      const conv = make(NewConversationContextItem);
      row('new conversation failed', conv.getStatusUI(failure));
      row('new conversation pending', conv.getStatusUI(pending));
      row('new conversation unstarted', conv.getStatusUI(null));
      row('new conversation untitled', conv.getStatusUI(ok({ conversationId: '12', name: '12' })));
      shown['new conversation type name (static)'] = NewConversationContextItem.getTypeName();

      const raw = Object.entries(shown).filter(([, s]) => !isPseudoLocalized(s));
      if (raw.length) throw new Error(`plain English under en-XA: ${JSON.stringify(Object.fromEntries(raw))}`);

      // The failed row still carries the model's error as given.
      const failedRow = /** @type {any} */ (fetch.getStatusUI(failure, url));
      if (!String(failedRow?.summary).includes('9')) throw new Error(`the error is missing: ${JSON.stringify(failedRow?.summary)}`);
    }, { '@juggler/core': CORE_TEXT });
    passed++;
  } catch (e) {
    failed++;
    errors.push(`en-XA: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { passed, failed, errors };
}
