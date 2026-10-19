//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"juggler/cmd/juggler/providers/provider"
)

// Register adds this provider to the global registry. Lifecycle (cancel,
// close, shutdown) is handled per-conversation through the Conversation
// handle returned by OpenConversation; the server's
// conversationCache.Shutdown closes every live handle on its way out.
func Register() {
	provider.RegisterProvider(Info(), NewClient)
}
