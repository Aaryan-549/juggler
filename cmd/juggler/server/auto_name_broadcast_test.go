//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"strings"
	"testing"
	"time"

	"juggler/cmd/juggler/core"
)

// namingOps drains everything the viewer has been sent and returns the
// conversations-changed ops among it as "op:id", in arrival order. The window
// is generous for the reason countNotices gives.
func namingOps(t *testing.T, c *WSClient) []string {
	t.Helper()
	var ops []string
	deadline := time.After(500 * time.Millisecond)
	for {
		select {
		case msg := <-c.send:
			m, ok := msg.json.(map[string]any)
			if !ok || m["type"] != "conversations-changed" {
				continue
			}
			op, _ := m["op"].(string)
			id, _ := m["id"].(string)
			ops = append(ops, op+":"+id)
		case <-deadline:
			return ops
		}
	}
}

// TestAutoNameBracketsItsWorkWithBroadcasts: every viewer is told when a
// conversation starts being named and when that stops, however it stops. The
// tab says "Auto-naming…" in between, so an end that is never sent is a tab
// that says it for good — this run gives up early, on a cheap model that cannot
// be resolved, and must still close the bracket.
func TestAutoNameBracketsItsWorkWithBroadcasts(t *testing.T) {
	registerCheapTestProvider("nohint", "")
	s, viewer := newCheapNoticeServer(t, unresolvableProviders())

	s.autoNameConversation("c1", "hello", "", true, core.ModelRef{Provider: "nohint", Model: "big"})

	got := strings.Join(namingOps(t, viewer), " ")
	if want := "naming-started:c1 naming-ended:c1"; got != want {
		t.Fatalf("broadcast %q, want %q", got, want)
	}
}

// TestAutoNameSkippedSaysNothing: an automatic naming that its guard turns away
// (the name is not provisional — here, no worker can vouch that it is) never
// began, so no viewer is told it did.
func TestAutoNameSkippedSaysNothing(t *testing.T) {
	registerCheapTestProvider("nohint", "")
	s, viewer := newCheapNoticeServer(t, unresolvableProviders())

	s.autoNameConversation("c1", "hello", "", false, core.ModelRef{Provider: "nohint", Model: "big"})

	if got := namingOps(t, viewer); len(got) != 0 {
		t.Fatalf("broadcast %q for a naming that never began", got)
	}
}
