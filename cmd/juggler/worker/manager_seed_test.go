//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"testing"
	"time"
)

// TestSeedingAConversationLeavesTheManagerFree pins where a seed waits. Seeding
// initializes the new conversation's worker and saves its document before the
// server announces it, and both are waits on that one worker — its mailbox and
// its disk. The Manager's goroutine serves every conversation, so it must not be
// the one waiting: a slow save there stalls every other conversation's traffic
// behind it.
func TestSeedingAConversationLeavesTheManagerFree(t *testing.T) {
	m := NewManager()
	projectDir := t.TempDir()
	m.SetPathProvider(func(string) (string, bool) { return projectDir, true })

	saving := make(chan struct{}, 1)
	release := make(chan struct{})
	m.SetSaveBinary(func(string, []byte) error {
		select {
		case saving <- struct{}{}:
		default:
		}
		<-release
		return nil
	})
	t.Cleanup(func() {
		select {
		case <-release:
		default:
			close(release)
		}
		m.Shutdown()
	})

	seeded := make(chan error, 1)
	go func() {
		seeded <- m.SeedNewConversation("conv-seeded", "Seeded", projectDir, "2026-10-19T00:00:00Z", nil)
	}()
	select {
	case <-saving:
	case <-time.After(10 * time.Second):
		t.Fatal("the seed never saved its document")
	}

	answered := make(chan int, 1)
	go func() { answered <- m.Count() }()
	select {
	case n := <-answered:
		if n != 1 {
			t.Errorf("Count = %d, want the seeded worker", n)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the Manager stopped answering while one conversation's seed waited on its save")
	}

	close(release)
	select {
	case err := <-seeded:
		if err != nil {
			t.Fatalf("SeedNewConversation: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the seed never returned once its save was released")
	}
}
