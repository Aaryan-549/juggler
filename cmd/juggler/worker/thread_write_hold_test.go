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
	w.turn.thread = threadContext{itemID: callerID}
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
	w.turn.thread = threadContext{itemID: callerID}
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

// A turn and a send name their thread once and write into it for a long time
// after: a turn for its whole run, a send across the holds that check the
// thread is idle. Meanwhile a viewer can delete the thread, or replace it with
// a copy under the same id, as a refold does. y-crdt does not cascade a delete
// into the types nested under the deleted item, so an array resolved before it
// never reads as gone: reads keep returning the old transcript and writes into
// it vanish. Every read and write therefore finds the thread by id where it
// happens.

// replaceLastRootThread swaps the root's last item, a thread, for a fresh empty
// thread carrying the same id, as a viewer's refold does.
func replaceLastRootThread(w *ConversationWorker, threadID string) {
	deleteLastRootItem(w)
	index := w.doc.GetItemsLength()
	w.doc.InsertThread(index, "refolded")
	if err := w.doc.UpdateItemID(index, threadID); err != nil {
		panic(err)
	}
}

func threadHasItem(w *ConversationWorker, threadID, itemID string) bool {
	arr := w.doc.GetThreadItemsArray(threadID)
	if arr == nil {
		return false
	}
	for _, it := range w.doc.GetItemsFromArray(arr) {
		if it.ItemID == itemID {
			return true
		}
	}
	return false
}

func TestTurnWritesFollowItsThreadByID(t *testing.T) {
	w := newHoldTestWorker(t)
	threadID, err := w.currentRun().spawnThread(threadSpec{Goal: "work", Prompt: "do the work"}, toolSpawn{})
	if err != nil {
		t.Fatalf("spawnThread: %v", err)
	}
	tr := w.currentRun().beginTurn(threadID)
	defer w.sched.unregister(tr.t)
	replaceLastRootThread(w, threadID)

	tr.appendTargetMessage(ConversationItem{Type: ItemTypeAssistant, ItemID: "a-1", Content: "partial"})
	if !threadHasItem(w, threadID, "a-1") {
		t.Fatal("the turn's append did not reach the thread now carrying its id: it went into the replaced one")
	}
	if err := tr.updateTargetItemByID("a-1", "content", "streamed"); err != nil {
		t.Errorf("updateTargetItemByID: %v", err)
	}
	if items := tr.getTargetItems(); len(items) != 1 || items[0].Content != "streamed" {
		t.Errorf("the turn reads %+v, want the one streamed item in the live thread", items)
	}
}

func TestTurnOnADeletedThreadReadsNothingAndWritesNothing(t *testing.T) {
	w := newHoldTestWorker(t)
	threadID, err := w.currentRun().spawnThread(threadSpec{Goal: "work", Prompt: "do the work"}, toolSpawn{})
	if err != nil {
		t.Fatalf("spawnThread: %v", err)
	}
	tr := w.currentRun().beginTurn(threadID)
	defer w.sched.unregister(tr.t)
	deleteLastRootItem(w)
	rootBefore := w.doc.GetItemsLength()

	if items := tr.getTargetItems(); len(items) != 0 {
		t.Errorf("the turn still reads %d items of a deleted thread", len(items))
	}
	tr.appendTargetMessage(ConversationItem{Type: ItemTypeAssistant, ItemID: "a-1", Content: "lost"})
	if err := tr.updateTargetItemByID("a-1", "content", "lost"); err == nil {
		t.Error("updating an item of a deleted thread succeeded, want an error")
	}
	if got := w.doc.GetItemsLength(); got != rootBefore {
		t.Errorf("root items = %d after writes to a deleted thread, want %d", got, rootBefore)
	}
}

func TestSendFollowsItsThreadByID(t *testing.T) {
	w := newHoldTestWorker(t)
	threadID, err := w.currentRun().spawnThread(threadSpec{Goal: "work", Prompt: "do the work"}, toolSpawn{})
	if err != nil {
		t.Fatalf("spawnThread: %v", err)
	}
	dest, ok := w.resolveThread(threadID)
	if !ok {
		t.Fatal("resolveThread did not find the thread")
	}
	replaceLastRootThread(w, threadID)

	w.currentRun().addUserMessageTo(dest, UserMessageInput{Text: "follow-up"})
	items := w.itemsIn(dest)
	if len(items) != 1 || items[0].Content != "follow-up" {
		t.Errorf("the thread now carrying the id holds %+v, want the sent message", items)
	}
}
