//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// The actor assertion as test builds run it. Production builds compile
// actor_guard_assert_production.go instead, where it is a no-op.

//go:build !production

package worker

import (
	"fmt"
	"os"
	"runtime/debug"

	"juggler/internal/jlog"
)

// assertActor ends the process when the caller is not the actor: what is the
// state being reached. A violation is a data race the race detector may never
// see — the doc lock orders most of what surrounds it — so it is made fatal
// where it happens rather than left for a map write to corrupt.
//
// It exits rather than panicking because every goroutine that reaches this
// state recovers panics (a turn, a handler, a reducer pass), and a recovered
// violation is a test that passes.
func (g *actorGuard) assertActor(what string) {
	if violation := g.violation(what); violation != "" {
		jlog.Error("%s", violation)
		fmt.Fprintln(os.Stderr, violation)
		os.Exit(2)
	}
}

// violation describes the caller reaching what off the actor, or "" when it is
// on it.
func (g *actorGuard) violation(what string) string {
	if g.onActor() {
		return ""
	}
	return fmt.Sprintf("[actor guard] %s is the worker actor's alone, and goroutine %d reached it (the actor is goroutine %d)\n%s",
		what, currentGoroutineID(), g.goroutine.Load(), debug.Stack())
}
