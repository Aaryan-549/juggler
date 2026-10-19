//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package syswake

import "testing"

// subscribed counts the handlers a wake would run.
func subscribed() int { return len(*subs.Load()) }

// The subscription is global, so a subscriber that outlives its owner — a
// server shut down in a process that goes on to start another — would keep its
// owner reachable and be run on every wake after. Unsubscribing removes exactly
// the one handler it was returned for, and doing it twice removes nothing more.
func TestOnWake_UnsubscribeRemovesOnlyItsOwnHandler(t *testing.T) {
	base := subscribed()

	var firstRan, secondRan bool
	stopFirst := OnWake(func() { firstRan = true })
	stopSecond := OnWake(func() { secondRan = true })
	if got := subscribed(); got != base+2 {
		t.Fatalf("%d subscribers after two subscriptions, want %d", got, base+2)
	}

	stopFirst()
	stopFirst()
	if got := subscribed(); got != base+1 {
		t.Fatalf("%d subscribers after one unsubscribe (twice), want %d", got, base+1)
	}
	for _, s := range (*subs.Load())[base:] {
		s.fn()
	}
	if firstRan || !secondRan {
		t.Fatalf("after unsubscribing the first, a wake ran first=%v second=%v; want only the second", firstRan, secondRan)
	}

	stopSecond()
	if got := subscribed(); got != base {
		t.Fatalf("%d subscribers after both unsubscribed, want %d", got, base)
	}
}

func TestOnWake_NilHandlerUnsubscribesHarmlessly(t *testing.T) {
	base := subscribed()
	OnWake(nil)()
	if got := subscribed(); got != base {
		t.Fatalf("%d subscribers, want %d", got, base)
	}
}
