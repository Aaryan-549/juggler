//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Copying a conversation as Markdown — what the transcript keeps, what it
 * leaves out, and the footer button that offers it.
 *   1. The user and the agent speak under a heading each time the speaker
 *      changes; the agent's tool calls and sub-threads sit under its heading as
 *      one-line quotes, and a sub-thread carries the answer it handed back.
 *   2. Standing context, thinking and hidden provider state are not
 *      conversation, so none of it reaches the copy.
 *   3. The footer's copy button sits beside the log button and copies the
 *      whole conversation, even from a sub-thread's column.
 *   4. A tab's right-click menu offers the same copy for that tab's
 *      conversation.
 * @module unit-tests/conversation-markdown-test
 */

import {
  initializeRegistries,
  createTestSession,
  createTestConversation,
  assert
} from '../utilities/test-helpers.js';
import '../../js/components/conversation-footer.js';
import '../../js/components/token-display.js';
import '../../js/components/conversation-bar.js';
import Session from '../../js/model/session.js';
import ConversationRegistry from '../../js/model/conversation-registry.js';
import { resolveMenu } from '../../js/services/context-menu-service.js';
import { conversationToMarkdown } from '../../js/utils/conversation-markdown.js';

/**
 * Run the conversation-markdown test suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Counts of passed/failed checks and any error messages.
 */
export async function runTests() {
  await initializeRegistries();

  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];
  /**
   * @param {unknown} e - Whatever a check threw.
   * @returns {string} The error's message.
   */
  const msg = (e) => e instanceof Error ? e.message : String(e);

  const session = await createTestSession();
  const conversation = await createTestConversation(session);
  const thread = conversation.rootMessageThread;
  thread.addEvent({ type: 'memory', content: 'STANDING-CONTEXT' });
  thread.addEvent({ type: 'user', content: 'Fix the **build**' });
  thread.addEvent({ type: 'thinking', content: 'PRIVATE-REASONING' });
  thread.addEvent({ type: 'assistant', content: 'Looking.\n\n```js\nx();\n```' });
  thread.addEvent({ type: 'tool-action', toolName: 'bash', toolUseId: 'tu-1', toolInput: { command: 'make test', description: 'Run the tests' } });
  thread.addEvent({ type: 'tool-action', toolName: 'read', toolUseId: 'tu-2', toolInput: { file_path: '/a/b.go' } });
  thread.addEvent({ type: 'thread', goal: 'Trace the failure', result: 'It was the linker.\nSecond line.', items: [] });
  thread.addEvent({ type: 'assistant', content: 'Fixed.' });
  thread.addEvent({ type: 'user', content: 'Thanks' });

  // --- 1: speakers, tools and sub-threads ---------------------------------
  try {
    const md = conversationToMarkdown(conversation);
    const expectedBody = [
      '## User',
      '',
      'Fix the **build**',
      '',
      '## Assistant',
      '',
      'Looking.\n\n```js\nx();\n```',
      '',
      '> **Tool** `bash`: Run the tests',
      '',
      '> **Tool** `read`: /a/b.go',
      '',
      '> **Sub-thread**: Trace the failure',
      '>',
      '> It was the linker.',
      '> Second line.',
      '',
      'Fixed.',
      '',
      '## User',
      '',
      'Thanks',
      '',
    ].join('\n');
    assert(md.endsWith(expectedBody),
      `transcript body, got:\n${md}`);
    // One heading per change of speaker, not one per item: the agent's prose,
    // tools and sub-thread are all one reply.
    assert(md.split('## Assistant').length === 2, 'one Assistant heading for one reply');
    passed++;
  } catch (e) { failed++; errors.push(`transcript: ${msg(e)}`); }

  // --- 2: what is not conversation stays out --------------------------------
  try {
    const md = conversationToMarkdown(conversation);
    assert(!md.includes('STANDING-CONTEXT'), 'standing context items are not copied');
    assert(!md.includes('PRIVATE-REASONING'), 'thinking is not copied');
    passed++;
  } catch (e) { failed++; errors.push(`exclusions: ${msg(e)}`); }

  // --- 3: the footer button --------------------------------------------------
  const footer = /** @type {any} */ (document.createElement('conversation-footer'));
  document.body.appendChild(footer);
  try {
    footer.setMessageThread(thread);
    const btn = /** @type {HTMLElement|null} */ (footer.querySelector('.footer-copy-btn'));
    assert(!!btn, 'the footer has a copy-conversation button');
    assert(btn?.classList.contains('copy-button'), 'made by createCopyButton, so it gets the Copied bubble');
    const activity = footer.querySelector('.footer-activity');
    assert(btn?.parentElement === activity && btn?.nextElementSibling === footer.querySelector('.footer-log-btn'),
      'it sits immediately before the log button, in the same group');
    // Its "Copied" bubble opens upward out of the footer, over the transcript.
    // A footer clipping its vertical overflow cuts the bubble off at its own
    // top edge; only the sideways overflow may be clipped.
    const footerStyle = getComputedStyle(footer);
    assert(footerStyle.overflowY === 'visible',
      `the footer lets the bubble rise out of it, got overflow-y: ${footerStyle.overflowY}`);
    assert(footerStyle.overflowX === 'clip',
      `the footer still clips sideways, got overflow-x: ${footerStyle.overflowX}`);

    /** @type {string[]} */
    const copied = [];
    const clip = /** @type {any} */ (navigator).clipboard;
    const original = clip?.writeText;
    if (clip) clip.writeText = async (/** @type {string} */ text) => { copied.push(text); };
    try {
      btn?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      if (clip) clip.writeText = original;
    }
    assert(copied.length === 1 && copied[0] === conversationToMarkdown(conversation),
      `one click copies the conversation's Markdown, got ${JSON.stringify(copied)}`);
    passed++;
  } catch (e) {
    failed++;
    errors.push(`footer button: ${msg(e)}`);
  } finally {
    footer.remove();
  }

  // --- 4: the tab's right-click menu ----------------------------------------
  // A Session carrying only what the strip reads, over the real conversation, so
  // the menu row runs the same load-then-copy path a click on any tab does.
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:0;top:0;width:360px;height:900px;';
  try {
    const stripSession = /** @type {any} */ (Object.create(Session.prototype));
    stripSession.workspaces = [];
    stripSession.projectPath = '/tmp/project';
    stripSession.bin = { count: 0, sizeBytes: 0 };
    stripSession._listeners = new Map();
    stripSession.registry = new ConversationRegistry();
    stripSession.registry.insert(conversation.id, conversation, 'test');
    stripSession.save = () => {};
    stripSession._requestConversationLoad = () => {};
    stripSession._notify = () => {};

    host.appendChild(document.createElement('conversation-tabs-container'));
    document.body.appendChild(host);
    const bar = /** @type {any} */ (document.createElement('conversation-bar'));
    host.appendChild(bar);
    bar._session = stripSession;
    bar.render();

    const tab = /** @type {Element|null} */ (
      bar.querySelector(`.conversation-tab[data-conversation-id="${conversation.id}"]`));
    assert(!!tab, 'the strip draws a tab for the conversation');
    const menu = resolveMenu(/** @type {Element} */ (tab));
    const row = menu?.items.find((item) => item.label === 'Copy Conversation to Clipboard');
    assert(!!row?.onClick, `the tab's menu offers Copy Conversation to Clipboard, got ${JSON.stringify(menu?.items.map((i) => i.label))}`);

    /** @type {string[]} */
    const copied = [];
    const clip = /** @type {any} */ (navigator).clipboard;
    const original = clip?.writeText;
    if (clip) clip.writeText = async (/** @type {string} */ text) => { copied.push(text); };
    try {
      await bar._copyConversationMarkdown(conversation.id);
    } finally {
      if (clip) clip.writeText = original;
    }
    assert(copied.length === 1 && copied[0] === conversationToMarkdown(conversation),
      `the row copies that conversation's Markdown, got ${JSON.stringify(copied)}`);
    passed++;
  } catch (e) {
    failed++;
    errors.push(`tab menu: ${msg(e)}`);
  } finally {
    host.remove();
  }

  return { passed, failed, errors };
}
