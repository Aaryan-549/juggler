//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Find the `<conversation-tab>` a lane shows a conversation in.
 *
 * A conversation holds no reference to its tab; in the app the tab bar keeps
 * that lookup (`ConversationBar#getTabElement`). A lane has no bar — the UI
 * harness mounts a bare tab of its own — so tests find it in the document by
 * the conversation it is showing. A headless lane mounts no tab, and gets null.
 * @module utilities/conversation-tab-lookup
 */

/**
 * @param {{id: string}} conversation - The conversation whose tab is wanted.
 * @param {ParentNode} [root] - Where to look; the lane's document by default.
 * @returns {any} The tab element, or null when the lane shows none for it.
 */
export function tabFor(conversation, root = document) {
  const id = conversation?.id;
  if (!id) return null;
  return [...root.querySelectorAll('conversation-tab')]
    .find((tab) => /** @type {any} */ (tab).getConversation?.()?.id === id) || null;
}
