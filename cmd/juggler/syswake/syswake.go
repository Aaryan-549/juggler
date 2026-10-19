//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package syswake is a tiny, lock-free pub/sub for "the OS resumed from
// sleep" events. The platform sleep/wake observer (darwin: the NSWorkspace
// DidWake hook in cmd/juggler) calls Fire(); interested subsystems (the
// worker Manager, which cancels LLM requests orphaned by the sleep) register
// via OnWake(), and unsubscribe with the func it returns when they end.
//
// It exists to decouple the cgo wake callback (package main) from the worker
// Manager (created in the server package) without either importing the
// other. Subscribers run in their own goroutines so a slow handler can't
// stall the wake callback, which on macOS may run on the main thread.
//
// Lock-free by design (per the project's goroutines-and-channels rule): the
// subscriber list is an immutable slice behind an atomic pointer, replaced
// whole by compare-and-swap on every change, so Fire reads it without a lock.
package syswake

import (
	"slices"
	"sync/atomic"
)

// subscriber is one OnWake registration. A pointer, so that unsubscribing can
// find exactly its own entry.
type subscriber struct{ fn func() }

var subs atomic.Pointer[[]*subscriber]

func init() {
	empty := []*subscriber{}
	subs.Store(&empty)
}

// OnWake registers fn to be invoked on every system-wake, and returns the func
// that removes it again. The subscription is process-global, so an owner that
// can end before the process does — a server, which Shutdown ends — must call
// it, or it stays reachable and keeps being woken. Unsubscribing twice is
// harmless.
//
// Registration is cross-platform, but only platforms with a sleep/wake
// observer that calls Fire (currently darwin) will ever invoke the handlers;
// elsewhere subscribers register harmlessly and never fire.
func OnWake(fn func()) (unsubscribe func()) {
	if fn == nil {
		return func() {}
	}
	// Removal is by this entry's identity: funcs cannot be compared, and the
	// same func may be subscribed twice.
	entry := &subscriber{fn: fn}
	update(func(cur []*subscriber) []*subscriber {
		return append(slices.Clone(cur), entry)
	})
	return func() {
		update(func(cur []*subscriber) []*subscriber {
			return slices.DeleteFunc(slices.Clone(cur), func(s *subscriber) bool { return s == entry })
		})
	}
}

// update swaps in next(current) for the subscriber list, retrying until no
// concurrent update intervened. next must not modify the slice it is given.
func update(next func([]*subscriber) []*subscriber) {
	for {
		old := subs.Load()
		replacement := next(*old)
		if subs.CompareAndSwap(old, &replacement) {
			return
		}
	}
}
