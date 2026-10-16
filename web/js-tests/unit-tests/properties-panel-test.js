//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The properties panel's own chrome — empty state, the transaction view's
 * header and "not part of a round-trip" note, the token chip's tooltips, the
 * View-transaction button, the catalog-link badge, and the message,
 * context-item and tool-action controls — follows the UI language.
 *
 * Item bodies are drawn by `item-renderers.js` and `properties-panel-helpers.js`
 * and are covered by their own suites; this walks only what
 * `properties-panel.js` (and the delete buttons it appends) draws. The panel
 * is a detached element given a fake thread, so no conversation is created.
 * @module unit-tests/properties-panel-test
 */

import '../../js/components/properties-panel.js';
import { TOOL_STATES } from '../../sdk/lib/message.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';
import { assert } from '../utilities/test-helpers.js';
import { underPseudoLocale, shownStrings } from '../utilities/pseudo-locale.js';

/**
 * A Y.Map-ish item.
 * @param {Record<string, any>} fields - Field values keyed by name.
 * @returns {{get: (k: string) => any}} An item exposing `.get(key)`.
 */
function item(fields) {
  return { get: (k) => fields[k] };
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  // en-XA — every state the panel's own code draws. Data is digits, so a
  // string with no letter at all is data and is left out.
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:600px;height:600px;';
  document.body.appendChild(host);
  try {
    await underPseudoLocale('properties-panel-test', async () => {
      /** @type {{where: string, text: string}[]} */
      const shown = [];
      const collect = (/** @type {string} */ where, /** @type {string[]} */ strings) => {
        for (const text of strings) if (/\p{L}/u.test(text)) shown.push({ where, text });
      };
      // shownStrings reads attributes only below its root, so a lone element
      // whose tooltip is the point is wrapped first.
      const wrapped = (/** @type {Element} */ el) => {
        const box = document.createElement('div');
        box.appendChild(el);
        return box;
      };

      const panel = /** @type {any} */ (document.createElement('properties-panel'));
      host.appendChild(panel);
      const content = () => /** @type {Element} */ (panel.querySelector('properties-panel-content'));

      // Nothing selected: the first paint, and the empty state a render falls back to.
      collect('first paint', shownStrings(content()));
      const emptyBox = document.createElement('div');
      panel._renderEmptyState(emptyBox);
      collect('empty state', shownStrings(emptyBox));

      // The transaction view for an item that was never part of a round-trip.
      panel.setTransaction('1', '');
      const txNote = content().querySelector('properties-panel-body');
      assert(!!txNote?.textContent?.trim(), 'the transaction view drew no note');
      collect('transaction view', shownStrings(content()));
      panel.selectItem(null);

      // A fake thread: a queued message, then committed items.
      const queued = item({ itemId: '1', type: 'user', content: '1' });
      const first = item({ itemId: '2', type: 'user', content: '2' });
      const user = item({ itemId: '3', type: 'user', content: '3' });
      const tool = item({
        itemId: '4', type: 'tool-action', toolUseId: '4', state: TOOL_STATES.RUNNING,
        result: { content: '4', isError: false },
      });
      const reply = item({ itemId: '6', type: 'assistant', content: '1111', transactionId: '9' });
      const loneReply = item({ itemId: '7', type: 'assistant', content: '1111' });
      const items = [first, user, tool, reply, loneReply];
      const thread = {
        items,
        pendingItems: [queued],
        conversation: {},
        findIndexByItemId: (/** @type {string} */ id) => items.findIndex((i) => i.get('itemId') === id),
        getContextItem: () => null,
      };
      panel._messageThread = thread;
      panel._conversation = { id: '1', toolActionClass: () => null };

      // Message controls: queued, then a committed user message.
      collect('queued message controls', shownStrings(wrapped(panel._renderMessageControls(queued))));
      const userControls = panel._renderMessageControls(user);
      assert(userControls.querySelectorAll('button').length >= 5, 'the user message drew too few controls');
      collect('user message controls', shownStrings(wrapped(userControls)));

      // Context-item controls: refreshable, outside the thread (plain Remove).
      const contextItem = { id: '5', refresh() {}, preventUserDeletion: () => false };
      collect('context item controls', shownStrings(wrapped(panel._renderContextItemControls(contextItem))));

      // Tool-action controls: a busy tool with a result (Re-run, blocked Delete).
      const toolControls = panel._renderToolActionControls(tool);
      const blocked = /** @type {HTMLButtonElement|null} */ (toolControls.querySelector('button[disabled]'));
      assert(!!blocked?.title, 'the busy tool drew no blocked-Delete tooltip');
      collect('tool action controls', shownStrings(wrapped(toolControls)));

      // Token chips: an estimate, then a provider-reported count.
      panel._selectedItemId = '7';
      const estimate = panel._buildTokenChip();
      assert(!!estimate?.title, 'the estimate chip has no tooltip');
      collect('estimate chip', shownStrings(wrapped(estimate)));
      panel._selectedItemId = '6';
      panel._blobOutputTokens.set('9', 5);
      const reported = panel._buildTokenChip();
      assert(reported?.textContent === '5', `the reported chip did not paint, got "${reported?.textContent}"`);
      collect('reported chip', shownStrings(wrapped(reported)));
      panel._selectedItemId = null;

      // The header's View-transaction button and catalog-linked badge.
      collect('view transaction button', shownStrings(wrapped(panel._buildViewTransactionButton())));
      const header = panel._createHeader('7', { color: 'slate', pluginId: '1' });
      const badge = header.querySelector('.badge-catalog-link');
      assert(!!badge, 'the header drew no catalog link');
      collect('catalog badge', [badge?.getAttribute('title') || '', badge?.getAttribute('aria-label') || '']);

      panel._messageThread = null;
      panel._conversation = null;
      panel._stopElapsedTicker();

      assert(shown.length >= 20, `expected at least 20 strings, found ${shown.length}`);
      const raw = shown.filter((s) => !isPseudoLocalized(s.text));
      assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
    });
    passed++;
  } catch (e) {
    failed++;
    errors.push(`en-XA panel chrome: ${e instanceof Error ? `${e.message}\n${e.stack}` : String(e)}`);
  } finally {
    host.remove();
  }

  return { passed, failed, errors };
}
