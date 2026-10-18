//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"context"
	"encoding/json"
	"sync/atomic"
	"testing"
	"time"

	ycrdt "github.com/skyterra/y-crdt"
)

// TestNavRecoilDoesNotFeedItsOwnObserver pins that the post-undo recoil window
// settles instead of writing the document in a loop.
//
// Inside the window every items change releases the LLM claims. The release is a
// document write, and every document write is an items change, so a release that
// writes when there is nothing left to release re-enters itself for the whole
// window: one change becomes as many transactions as the worker can run in
// 500ms. Each of them is broadcast, and the viewer has to merge and apply every
// one — in the browser pool, three lanes on one main thread doing that at once
// held their acks back past the 5s ack timeout.
//
// The count is of document updates, the thing the loop multiplies. A settled
// window costs the poke plus at most one release; the loop costs thousands, so
// the bound holds however slow the machine is.
func TestNavRecoilDoesNotFeedItsOwnObserver(t *testing.T) {
	w := NewConversationWorker("conv-nav-recoil", "user:test")
	w.currentRun().Start(context.Background())
	defer w.currentRun().Stop()

	acks := make(chan string, 16)
	w.SetCallback("viewer", func(raw []byte) {
		var m struct {
			Type  string `json:"type"`
			AckID string `json:"ackId"`
		}
		if json.Unmarshal(raw, &m) == nil && m.Type == "ack" {
			acks <- m.AckID
		}
	})

	// A conversation that has run a turn carries a processingState frame, which
	// is what the release reads.
	w.doc.SetMetadata("processingState", map[string]any{"status": "idle"})

	var updates atomic.Int64
	ycrdtMu.Lock()
	w.doc.doc.On("update", &ycrdt.ObserverHandler{Callback: func(...any) { updates.Add(1) }})
	ycrdtMu.Unlock()

	payload, _ := json.Marshal(map[string]string{"ackId": "undo-1"})
	w.SendFromClient("viewer", "undo", payload)
	select {
	case <-acks:
	case <-time.After(5 * time.Second):
		t.Fatal("undo was never acknowledged")
	}

	// Any document change inside the window — here a viewer echo, as Yjs sync
	// delivers right after an undo — reaches handleItemsChange in recoil.
	before := updates.Load()
	w.doc.SetMetadata("echo", "from-viewer")

	time.Sleep(historyNavRecoil + 100*time.Millisecond)
	if n := updates.Load() - before; n > 10 {
		t.Fatalf("one change inside the recoil window produced %d document updates; "+
			"the release is writing on every items change it causes", n)
	}
}
