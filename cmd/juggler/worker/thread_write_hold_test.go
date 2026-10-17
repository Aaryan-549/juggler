//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"testing"
)

// Opening a thread and invoking a session again each resolve where they write,
// decide, and write, and a turn makes both calls from its own goroutine while
// the run loop applies viewer syncs. Done in several ycrdtMu holds, a viewer's
// delete landing between them leaves the write aimed at a map or array that is
// no longer in the document: stamps land on whichever item slid into the
// thread's old index, and a resumed session's alias goes into a deleted
// caller while its invocation message starts a run nobody is waiting for.
// These pin both to one hold, and pin what they do when the target has gone.

// ycrdtHolds counts the acquisitions of ycrdtMu that fn makes. No test in this
// package runs in parallel, and a worker whose loop was never started takes
// the lock only when called, so the count is fn's own.
func ycrdtHolds(fn func()) uint64 {
	before := ycrdtMu.generation.Load()
	fn()
	return ycrdtMu.generation.Load() - before
}

// newHoldTestWorker returns a worker with a root items array and a run in
// progress, the state a turn spawning threads is in.
func newHoldTestWorker(t *testing.T) *ConversationWorker {
	t.Helper()
	w := NewConversationWorker("conv-thread-hold", "user:test")
	t.Cleanup(w.doc.Destroy)
	w.doc.ensureItems()
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	w.currentRun().storeState(StateProcessing)
	return w
}

// deleteLastRootItem deletes the root's last item, as a viewer's delete does.
func deleteLastRootItem(w *ConversationWorker) {
	w.doc.DeleteMessages([]int{w.doc.GetItemsLength() - 1})
}

func TestThreadCreationAndResumeTakeOneHold(t *testing.T) {
	w := newHoldTestWorker(t)

	var threadID string
	var err error
	holds := ycrdtHolds(func() {
		threadID, err = w.currentRun().spawnThread(threadSpec{
			Goal: "map auth", Prompt: "find the auth flow", ResultSpec: "the files involved",
		}, toolSpawn{
			ToolUseID: "tu-1", ToolName: "Explore", ToolInput: json.RawMessage(`{"prompt":"find the auth flow"}`),
			SessionName: "auth", Delegated: true,
		})
	})
	if err != nil {
		t.Fatalf("spawnThread: %v", err)
	}
	if holds != 1 {
		t.Errorf("creating a thread took ycrdtMu %d times, want 1", holds)
	}
	items := w.doc.GetItems()
	if last := items[len(items)-1]; last.ItemID != threadID || last.SessionName != "auth" {
		t.Errorf("the stamped thread is %q (session %q), want %q (session auth)", last.ItemID, last.SessionName, threadID)
	}

	holds = ycrdtHolds(func() {
		err = w.currentRun().resumeSession(threadID, threadSpec{Goal: "trace callers", Prompt: "who calls it?"}, toolSpawn{
			ToolUseID: "tu-2", ToolName: "Explore", ToolInput: json.RawMessage(`{"prompt":"who calls it?"}`),
			SessionName: "auth", Delegated: true,
		})
	})
	if err != nil {
		t.Fatalf("resumeSession: %v", err)
	}
	if holds != 1 {
		t.Errorf("resuming a session took ycrdtMu %d times, want 1", holds)
	}
}

func TestSpawnIntoADeletedThreadWritesNothing(t *testing.T) {
	w := newHoldTestWorker(t)
	callerID, err := w.currentRun().spawnThread(threadSpec{Goal: "caller", Prompt: "work"}, toolSpawn{})
	if err != nil {
		t.Fatalf("spawnThread(caller): %v", err)
	}
	w.turn.thread = threadContext{itemID: callerID, itemsArray: w.doc.GetThreadItemsArray(callerID)}
	deleteLastRootItem(w)
	rootBefore := w.doc.GetItemsLength()

	if _, err := w.currentRun().spawnThread(threadSpec{Goal: "child", Prompt: "more work"}, toolSpawn{ToolUseID: "tu-1", ToolName: "create_thread"}); err == nil {
		t.Error("spawning into a deleted thread succeeded, want an error")
	}
	if got := w.doc.GetItemsLength(); got != rootBefore {
		t.Errorf("root items = %d after a refused spawn, want %d", got, rootBefore)
	}
}

func TestResumeFromADeletedCallerWritesNothing(t *testing.T) {
	w := newHoldTestWorker(t)
	sessionID, err := w.currentRun().spawnThread(threadSpec{Goal: "map auth", Prompt: "find the auth flow"}, toolSpawn{
		ToolUseID: "tu-1", ToolName: "Explore", SessionName: "auth", Delegated: true,
	})
	if err != nil {
		t.Fatalf("spawnThread(session): %v", err)
	}
	callerID, err := w.currentRun().spawnThread(threadSpec{Goal: "caller", Prompt: "work"}, toolSpawn{})
	if err != nil {
		t.Fatalf("spawnThread(caller): %v", err)
	}
	w.turn.thread = threadContext{itemID: callerID, itemsArray: w.doc.GetThreadItemsArray(callerID)}
	deleteLastRootItem(w)
	session := w.doc.GetThreadItemsArray(sessionID)
	sessionBefore := w.doc.GetItemsLengthFromArray(session)

	err = w.currentRun().resumeSession(sessionID, threadSpec{Prompt: "who calls it?"}, toolSpawn{
		ToolUseID: "tu-2", ToolName: "Explore", SessionName: "auth", Delegated: true,
	})
	if err == nil {
		t.Error("resuming from a deleted caller succeeded, want an error")
	}
	if got := w.doc.GetItemsLengthFromArray(session); got != sessionBefore {
		t.Errorf("session items = %d after a refused resume, want %d: its invocation starts a run no caller waits for", got, sessionBefore)
	}
}
