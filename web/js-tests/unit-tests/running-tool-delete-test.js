//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * A tool-action that is still running (or approved and about to be claimed)
 * cannot be deleted on its own from the properties panel.
 *
 * Deleting it would not stop it: the tool keeps executing, and the result it
 * finishes with has no item to land on and is dropped. So the panel's plain
 * Delete is disabled while the tool is busy — and the Delete/Backspace key,
 * which works by clicking that button, does nothing either. Once the tool
 * reaches a terminal state the panel re-renders and Delete works again.
 * @module unit-tests/running-tool-delete-test
 */

import {
  initializeRegistries,
  createTestSession,
  createApprovalTestConversation,
  assert
} from '../utilities/test-helpers.js';
import {
  createUserMessage,
  createToolActionMessage,
  TOOL_STATES
} from '../../sdk/lib/message.js';
import '../../js/components/conversation-tab.js';

/**
 * Let the properties panel paint. Its content render is debounced by 150ms
 * (`ColumnBuilder.propertiesColumn`), and the Delete button arrives with it.
 * @returns {Promise<void>} Resolves once the panel has rendered.
 */
function settlePanel() {
  return new Promise((resolve) => { setTimeout(resolve, 300); });
}

/**
 * The open properties panel's plain Delete button.
 * @param {any} tab - The conversation-tab under test.
 * @returns {HTMLButtonElement} The button.
 */
function deleteButton(tab) {
  const panel = tab.querySelector('column-container > properties-panel');
  assert(!!panel, 'selecting the tool should have opened a properties panel');
  const btn = /** @type {HTMLButtonElement|null} */ (
    panel.querySelector('.properties-panel-btn.danger')
  );
  assert(!!btn, 'the properties panel should offer a Delete button');
  assert(/^\s*Delete\s*$/.test(btn.textContent || ''),
    `the first danger button must be plain Delete, got "${btn.textContent?.trim()}"`);
  return btn;
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  await initializeRegistries();

  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:1600px;height:800px;';
  document.body.appendChild(host);

  /** @type {any} */
  let session = null;
  /** @type {any} */
  let conversation = null;

  try {
    session = await createTestSession();
    conversation = await createApprovalTestConversation(session);
    const tab = /** @type {any} */ (document.createElement('conversation-tab'));
    host.appendChild(tab);
    tab.setConversation(conversation);
    tab.setActive();

    const root = conversation.rootMessageThread;
    const toolUseId = 'call_running_delete';
    conversation._doc.doc.transact(() => {
      root.addEvent(createUserMessage('Run something long'));
      root.addEvent(createToolActionMessage({
        toolUseId,
        toolName: 'bash',
        toolInput: { command: 'sleep 30' },
        state: TOOL_STATES.RUNNING
      }));
    }, conversation._doc.authorId);
    await settlePanel();

    const toolAction = root.getToolAction(toolUseId);
    const itemId = toolAction.get('itemId');
    const col = /** @type {any} */ (tab.querySelector('conversation-area'));
    col.selectItem(itemId);
    await settlePanel();

    try {
      const btn = deleteButton(tab);
      assert(btn.disabled, 'Delete must be disabled while the tool is running');

      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Delete', bubbles: true, cancelable: true
      }));
      await settlePanel();
      assert(root.findIndexByItemId(itemId) >= 0,
        'the Delete key must not remove a running tool-action');
      passed++;
    } catch (e) {
      failed++;
      errors.push(`running tool: ${e instanceof Error ? e.message : String(e)}`);
    }

    try {
      root.completeToolAction(toolUseId, { content: 'done', isError: false });
      await settlePanel();
      const btn = deleteButton(tab);
      assert(!btn.disabled, 'Delete must be enabled again once the tool has finished');
      passed++;
    } catch (e) {
      failed++;
      errors.push(`finished tool: ${e instanceof Error ? e.message : String(e)}`);
    }
  } catch (e) {
    failed++;
    errors.push(`harness: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    host.remove();
    // Conversations live in a session shared by every lane, so a test that
    // creates one deletes it.
    if (conversation) {
      try {
        await session?.deleteConversation(conversation.id, 'running-tool-delete:cleanup');
      } catch { /* the assertions have already been recorded */ }
    }
  }

  return { passed, failed, errors };
}
