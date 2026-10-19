//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"testing"
	"time"

	"juggler/cmd/juggler/providers/provider"
)

// TestShutdownWaitsForARemovedWorkersStop pins Shutdown to every worker the
// Manager started, including one it has already removed. Remove answers its
// caller before the worker has stopped — the folder move is waiting on it — and
// stops it on a goroutine of its own. Shutdown returning while that stop is
// still under way lets the process exit under a worker that is mid-teardown.
func TestShutdownWaitsForARemovedWorkersStop(t *testing.T) {
	m := NewManager()
	releasing := make(chan struct{}, 1)
	release := make(chan struct{})
	m.SetCancelLLMSession(func(_, threadItemID string) {
		if threadItemID != provider.CancelAllThreads {
			return
		}
		select {
		case releasing <- struct{}{}:
		default:
		}
		<-release
	})
	w := m.GetOrCreate("conv-removed", "user:test")
	defer w.doc.Destroy()

	m.Remove("conv-removed")
	select {
	case <-releasing:
	case <-time.After(10 * time.Second):
		t.Fatal("the removed worker never began to stop")
	}

	shutDown := make(chan struct{})
	go func() {
		m.Shutdown()
		close(shutDown)
	}()
	select {
	case <-shutDown:
		close(release)
		t.Fatal("Shutdown returned while a removed worker was still stopping")
	case <-time.After(300 * time.Millisecond):
	}

	close(release)
	select {
	case <-shutDown:
	case <-time.After(10 * time.Second):
		t.Fatal("Shutdown never returned once the removed worker could stop")
	}
	select {
	case <-w.stopped:
	default:
		t.Fatal("Shutdown returned before the removed worker had stopped")
	}
}
