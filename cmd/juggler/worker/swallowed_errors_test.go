//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"juggler/cmd/juggler/providers/provider"
	"juggler/internal/jlog"
)

// TestLoadFromStateReportsStateItCannotRead pins LoadFromState's error to
// something it can actually return: bytes that are not a document state are
// refused, with the lock released, rather than reported as loaded.
func TestLoadFromStateReportsStateItCannotRead(t *testing.T) {
	doc := NewConversationDocument("conv-unreadable", "user:test")
	defer doc.Destroy()
	if err := doc.LoadFromState([]byte{0xff, 0xff, 0xff, 0xff, 0x01, 0x02}); err == nil {
		t.Fatal("LoadFromState accepted bytes that are not a document state")
	}
	if !ycrdtMu.acquirableWithin(0) {
		t.Fatal("LoadFromState left the doc lock held after refusing the state")
	}
}

// TestOverflowRecoveryReportsARequestItCannotRead pins what a context overflow
// reports when the request it rejected cannot be read back. Recovery pins the
// model it compacts with from that request, so without it there is nothing to
// recover with — and the error that says so must name the unreadable request,
// not a missing model config, which would send the reader after the wrong bug.
func TestOverflowRecoveryReportsARequestItCannotRead(t *testing.T) {
	w := NewConversationWorker("conv-overflow-unreadable", "user:test")
	defer w.doc.Destroy()
	r := w.ownedRun(t)

	overflow := &provider.ContextLimitExceededError{EstimatedInputTokens: 3_000, OutputReserveTokens: 300, ContextWindowTokens: 2_000}
	_, settled, reportErr := r.resolveContextOverflow(&strategyRunState{}, overflow, json.RawMessage("{not a request"))
	if settled {
		t.Fatal("an overflow whose request cannot be read was settled as if recovery had run")
	}
	if reportErr == nil || !strings.Contains(reportErr.Error(), "could not read the rejected request") {
		t.Fatalf("reported %v; want the error to name the unreadable request", reportErr)
	}
}

// TestStreamedWriteToAGoneItemIsLoggedOncePerItem pins what a streaming write
// does when the item it rewrites has gone — deleted by a viewer mid-stream, say.
// The write fails, and the failure is worth a line in the conversation's log;
// but a streaming block rewrites its item many times a second, so it is one line
// per item, not one per write.
func TestStreamedWriteToAGoneItemIsLoggedOncePerItem(t *testing.T) {
	w := NewConversationWorker("conv-gone-item", "user:test")
	defer w.doc.Destroy()
	logPath := filepath.Join(t.TempDir(), "conv.log")
	w.log = jlog.NewLogger(logPath, 1, 1)

	r := w.currentRun()
	r.t.streaming.textMsgID = "gone-text-item"
	r.t.streaming.thinkingMsgID = "gone-thinking-item"
	for _, chunk := range []string{"one", " two", " three"} {
		r.t.streaming.textContent += chunk
		r.writeStreamingText()
		r.t.streaming.thinkingContent += chunk
		r.writeStreamingThinking()
	}
	w.log.Close()

	data, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("reading the conversation log: %v", err)
	}
	for _, id := range []string{"gone-text-item", "gone-thinking-item"} {
		if n := strings.Count(string(data), "item "+id+" not written"); n != 1 {
			t.Errorf("%s is named in %d log line(s), want exactly 1:\n%s", id, n, data)
		}
	}
}
