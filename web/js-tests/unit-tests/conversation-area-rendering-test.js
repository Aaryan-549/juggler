//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * What the transcript helpers draw around the items follows the UI language:
 * the queued-messages zone, the workspace banner in every state it can be in,
 * the compaction fold's result block, and the error row's fallback.
 *
 * Every helper is driven with a stand-in `area` on a detached list, so nothing
 * reaches the server and no custom element connects. Workspace labels, roots
 * and the name a workspace was finished with by are data, written in digits.
 * @module unit-tests/conversation-area-rendering-test
 */

import {
  ensurePendingMessages,
  ensureWorkspaceBanner,
  ensureThreadResult,
  positionElements,
} from '../../js/components/conversation-area-rendering.js';
import { MESSAGE_TYPES } from '../../sdk/lib/message.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';
import { assert } from '../utilities/test-helpers.js';
import { underPseudoLocale, shownStrings } from '../utilities/pseudo-locale.js';

/**
 * An item that reads like a Y.Map.
 * @param {Record<string, any>} fields
 * @returns {{get: (key: string) => any}} The stand-in item.
 */
function item(fields) {
  return { get: (key) => fields[key] };
}

/**
 * A root-column area bound to a workspace whose row is `row`.
 * @param {any} row - The workspace row, or null for one the table has lost.
 * @param {string|null} root - What `workspaceRoot` resolves to.
 * @returns {any} The stand-in area.
 */
function boundArea(row, root) {
  return {
    _conversation: {
      workspaceId: 'ws_rendering_xa',
      workspaceRoot: root,
      session: { getWorkspace: () => row, selectWorkspace: () => {} },
    },
  };
}

/**
 * Run the conversation-area-rendering test suite.
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

  await run('en-XA: every state the transcript helpers draw is translated', async () => {
    await underPseudoLocale('conversation-area-rendering-test', async () => {
      /** @type {Array<[string, string]>} */
      const seen = [];
      /**
       * @param {string} where - The state drawn
       * @param {string[]} strings - What it showed
       * @param {number} atLeast - How many it must have shown
       * @returns {void}
       */
      const see = (where, strings, atLeast) => {
        assert(strings.length >= atLeast, `${where}: expected at least ${atLeast} strings, got ${JSON.stringify(strings)}`);
        for (const s of strings) seen.push([where, s]);
      };

      // The queued-messages zone: its label and each bubble's remove button.
      {
        const list = document.createElement('div');
        const area = { _messageThread: { pendingItems: [item({ type: MESSAGE_TYPES.USER, itemId: 'q1', content: '7' })] } };
        ensurePendingMessages(area, list);
        const label = list.querySelector('.pending-messages-label');
        const button = list.querySelector('.queued-message-delete-btn');
        assert(!!label && !!button, 'the queue drew no label or no remove button');
        see('queue', [label?.textContent || '', button?.getAttribute('title') || '', button?.getAttribute('aria-label') || ''], 3);
      }

      // The workspace banner, with and without a label. The label and root are data.
      for (const label of ['7', '']) {
        const list = document.createElement('div');
        ensureWorkspaceBanner(boundArea({ id: 'ws_rendering_xa', label, root: '/7/8', state: 'ready', available: true }, '/7/8'), list);
        assert(!!list.querySelector('.workspace-banner-open'), `banner (label ${JSON.stringify(label)}): drew nothing`);
        see(`banner (label ${JSON.stringify(label)})`, shownStrings(list, '.workspace-banner-label, .workspace-banner-root'), 2);
      }

      // The stranded banner: every lead, and both buttons.
      /** @type {Array<[string, any]>} */
      const stranded = [
        ['stranded: no record', null],
        ['stranded: closed by someone', { id: 'ws_rendering_xa', label: '7', root: '/7', state: 'closed', available: true, meta: { closedBy: '8' } }],
        // The stored name is English; a placeholder one is drawn in the UI language.
        ['stranded: closed by an untitled conversation', { id: 'ws_rendering_xa', label: '7', root: '/7', state: 'closed', available: true, meta: { closedBy: 'Untitled 3' } }],
        ['stranded: closed by nobody named', { id: 'ws_rendering_xa', label: '7', root: '/7', state: 'closed', available: true, meta: {} }],
        ['stranded: not where it was', { id: 'ws_rendering_xa', label: '', root: '/7/9', state: 'ready', available: false }],
      ];
      for (const [where, row] of stranded) {
        const list = document.createElement('div');
        ensureWorkspaceBanner(boundArea(row, null), list);
        const lead = list.querySelector('.workspace-banner-lead');
        assert(!!lead?.textContent, `${where}: drew no lead`);
        see(where, shownStrings(list), row ? 2 : 3);
      }

      // The fold's result block, with no summary and with one (the summary is data).
      for (const result of ['', '7']) {
        const list = document.createElement('div');
        const footer = document.createElement('div');
        list.appendChild(footer);
        const area = {
          _threadYMap: item({ boundedCompaction: true, result, itemId: 't1' }),
          _snapshotLiveStatus: () => null,
        };
        ensureThreadResult(area, list, footer);
        assert(!!list.querySelector('.thread-result-label'), `fold (result ${JSON.stringify(result)}): drew nothing`);
        see(`fold (result ${JSON.stringify(result)})`, shownStrings(list, result ? '.thread-result-body' : undefined), 3);
      }

      // The error row's fallback when the item carries no text of its own.
      {
        const list = document.createElement('div');
        const footer = document.createElement('div');
        list.appendChild(footer);
        positionElements({}, list, footer, [item({ type: MESSAGE_TYPES.ERROR, itemId: 'e1' })], new Map());
        const row = list.querySelector('error-message');
        assert(!!row, 'the error item drew no row');
        see('error fallback', [row?.getAttribute('content') || ''], 1);
      }

      const raw = seen.filter(([, s]) => !isPseudoLocalized(s)).map(([where, s]) => `${where}: ${JSON.stringify(s)}`);
      assert(raw.length === 0, `plain English under en-XA:\n  ${raw.join('\n  ')}`);
    });
  });

  return { passed, failed, errors };
}
