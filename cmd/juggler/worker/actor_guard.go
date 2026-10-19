//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"bytes"
	"runtime"
	"strconv"
	"sync/atomic"
)

// actorGuard knows which goroutine is the worker's actor: the run loop, or, for
// a worker a test drives without starting it, the test goroutine standing in
// for one (quiesce binds it).
//
// Much of the worker's state is the actor's alone and carries no lock — the
// undo grouping, the delivery pumps, the tool-command tracker, the
// pendingRequests scan. A turn runs on a goroutine of its own and shares every
// method the actor has, so nothing in the type system stops a turn reaching that
// state. This is what does: the seams assert they are on the actor
// (assertActor, a no-op in production builds), and the few paths a turn and the
// actor share ask onActor to decide whether to act or to hand the work over.
//
// Until something binds it, every goroutine counts as the actor. That is the
// state of a worker under construction, and of a test calling handlers on a
// worker nobody runs.
type actorGuard struct {
	// goroutine is the bound actor's goroutine id, 0 while unbound.
	goroutine atomic.Int64
}

// bind makes the calling goroutine the actor.
func (g *actorGuard) bind() { g.goroutine.Store(currentGoroutineID()) }

// unbind releases the binding: the actor has gone, and with it the rule that
// only it may touch the state.
func (g *actorGuard) unbind() { g.goroutine.Store(0) }

// onActor reports whether the calling goroutine is the actor. A nil guard, held
// by a seam built bare in a test, answers true.
func (g *actorGuard) onActor() bool {
	if g == nil {
		return true
	}
	id := g.goroutine.Load()
	return id == 0 || id == currentGoroutineID()
}

// currentGoroutineID parses the calling goroutine's id from the header of its
// own stack trace ("goroutine 18 [running]:"). Go exposes the id nowhere else.
// It costs a stack walk of one frame, so it is for the guard and for routing a
// rare hand-off, never for a hot path.
func currentGoroutineID() int64 {
	var buf [64]byte
	b := buf[:runtime.Stack(buf[:], false)]
	b = bytes.TrimPrefix(b, []byte("goroutine "))
	if i := bytes.IndexByte(b, ' '); i >= 0 {
		b = b[:i]
	}
	id, err := strconv.ParseInt(string(b), 10, 64)
	if err != nil {
		return -1
	}
	return id
}
