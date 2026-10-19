//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests: the rows that fall back to a capability's `MANIFEST.name` (or to
 * the base `getTitle()`, which is that name) show it translated in its own
 * extension's catalogue — tool-action-message's running label, error, result
 * and no-plugin pending rows; context-item-message's error and fallback rows;
 * and the approval title the engine builds (`buildApprovalOptions`) for a
 * plugin with no approval config of its own. Tool names, action ids and errors are digits, which read as
 * data inside a message.
 * @module unit-tests/capability-name-readers
 */

import { assert } from '../utilities/test-helpers.js';
import { underPseudoLocale } from '../utilities/pseudo-locale.js';
import { buildApprovalOptions } from '../../js/services/response-handler-actions.js';
import contextItemRegistry from '../../js/registries/context-item-registry.js';
import ContextItem from '../../sdk/context-item.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';
import { TOOL_STATES } from '../../sdk/lib/message.js';
import '../../js/components/tool-action-message.js';
import '../../js/components/context-item-message.js';

const EXT = '@test/capability-names';
const NAME = 'Stand In Capability';
const ID = 'stand-in-capability';

/** A capability with only the base getTitle and getStatusUI (which returns null). */
class StatusLess extends ContextItem {
  static MANIFEST = { id: ID, name: NAME, version: '1.0.0', description: '9' };
  isPermitted() { return false; }
  async getApprovalConfig() { return null; }
  getApprovalSuggestions() { return []; }
}

/** A capability whose status row names no type, so the reader supplies it. */
class NoTypeName extends StatusLess {
  getStatusUI() { return { summary: '8', status: 'error' }; }
}

/**
 * Minimal Y.Map-ish item; nested result supports .get() like a Y.Map.
 * @param {Record<string, any>} fields - Field values keyed by name
 * @returns {{get: (k: string) => any}} A Y.Map-like item
 */
function fakeItem(fields) {
  const m = new Map(Object.entries(fields));
  if (fields.result && typeof fields.result === 'object') {
    const rm = new Map(Object.entries(fields.result));
    m.set('result', { get: (/** @type {string} */ k) => rm.get(k) });
  }
  return { get: (/** @type {string} */ k) => m.get(k) };
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0, failed = 0;
  /** @type {string[]} */
  const errors = [];

  const original = {
    getByToolName: contextItemRegistry.getByToolName,
    get: contextItemRegistry.get,
    getExtensionId: contextItemRegistry.getExtensionId,
  };
  /** @type {any} */
  let toolClass;
  contextItemRegistry.getByToolName = /** @type {any} */ (() => toolClass);
  contextItemRegistry.get = /** @type {any} */ ((/** @type {string} */ id) => (id === ID ? toolClass : original.get.call(contextItemRegistry, id)));
  contextItemRegistry.getExtensionId = (id) => (id === ID ? EXT : original.getExtensionId.call(contextItemRegistry, id));

  const conversation = { session: {} };
  const messageThread = { getContextItem: () => null };

  /**
   * A tool-action row over `fields`, with the conversation plumbing stubbed.
   * @param {Record<string, any>} fields - The fake item's fields
   * @returns {any} The element, rendered
   */
  const toolRow = (fields) => {
    const el = /** @type {any} */ (document.createElement('tool-action-message'));
    el._getConversation = () => conversation;
    el._getMessageThread = () => messageThread;
    el._getItem = () => fakeItem(fields);
    el._wrapWithIcon = (/** @type {HTMLElement} */ c) => c;
    el._appendApprovalRow = (/** @type {HTMLElement} */ article, /** @type {HTMLElement} */ status) => article.appendChild(status);
    return el;
  };
  /**
   * @param {Element} el
   * @param {string} selector
   * @returns {string} The text of the first match
   */
  const text = (el, selector) => el.querySelector(selector)?.textContent?.trim() || '';

  try {
    await underPseudoLocale('capability-name-readers-test', async () => {
      /** @type {Record<string, string>} */
      const shown = {};

      // tool-action-message: the footer's running label.
      toolClass = NoTypeName;
      shown['running label'] = toolRow({ state: TOOL_STATES.RUNNING, toolName: '5', toolInput: {} }).getBusyState()?.message;
      toolClass = StatusLess;
      shown['running, no status UI'] = toolRow({ state: TOOL_STATES.RUNNING, toolName: '5', toolInput: {} }).getBusyState()?.message;

      // The error-state type name the reader fills in.
      toolClass = NoTypeName;
      const errored = toolRow({ state: 'completed', toolName: '', result: { fullResult: { actionId: ID, success: false, error: '7' } } });
      errored._renderResult(errored._getItem());
      shown['error-state type'] = text(errored, '.context-item-type-badge');

      // The default rows of a plugin with no status UI.
      toolClass = StatusLess;
      const failedRow = toolRow({ state: 'completed', toolName: '', result: { fullResult: { actionId: ID, success: false, error: '7' } } });
      failedRow._renderResult(failedRow._getItem());
      shown['default error type'] = text(failedRow, '.context-item-type-badge');
      const done = toolRow({ state: 'completed', toolName: '', result: { fullResult: { actionId: ID, success: true } } });
      done._renderResult(done._getItem());
      shown['default completed'] = text(done, '.action-result-summary-text');

      // The pending row of a tool no plugin claims.
      toolClass = undefined;
      const pending = toolRow({ state: TOOL_STATES.PENDING, toolName: '5' });
      pending._renderPendingApproval(pending._getItem());
      shown['no-plugin pending'] = text(pending, '.pending-approval-label');

      // context-item-message: the error row and the fallback row.
      const instance = new StatusLess({ id: 'c1', session: {}, conversation, messageThread });
      /**
       * @param {string|null} error - The error attribute, if any
       * @returns {any} The rendered element
       */
      const itemRow = (error) => {
        const el = /** @type {any} */ (document.createElement('context-item-message'));
        el._getMessageThread = () => ({ getContextItem: () => instance });
        if (error) el.setAttribute('error', error);
        el.setAttribute('item-id', 'c1');
        el.render();
        return el;
      };
      shown['context item error type'] = text(itemRow('7'), '.context-item-type-badge');
      const fallback = itemRow(null);
      shown['context item fallback type'] = text(fallback, '.context-item-type-badge');
      shown['context item fallback summary'] = text(fallback, '.action-result-summary-text');

      // The approval title the engine builds for a plugin with no approval
      // config of its own.
      toolClass = StatusLess;
      shown['approval title'] = buildApprovalOptions(instance, {}).title;

      const raw = Object.entries(shown).filter(([, s]) => !s || !isPseudoLocalized(s));
      assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
    }, { [EXT]: [NAME] });
    passed++;
  } catch (e) {
    failed++;
    errors.push(`capability names are translated where they are read: ${/** @type {Error} */ (e).message}\n${/** @type {Error} */ (e).stack}`);
  } finally {
    Object.assign(contextItemRegistry, original);
  }

  return { passed, failed, errors };
}
