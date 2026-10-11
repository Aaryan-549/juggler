//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"testing"
)

// These tests guard the worker's half of "denying any call denies the batch".
// The browser applies that policy to the calls it can see; a batch is evaluated
// one call at a time, so the siblings of the call a person denies may still be
// unevaluated and invisible to it. The worker keeps the policy whole by
// refusing what a denial left behind — edge-triggered on the denial, so a call
// deliberately reset for a fresh ask is not cancelled again.

// stateOf reads one tool-action's state out of the worker's doc.
func stateOf(t *testing.T, w *ConversationWorker, toolUseID string) string {
	t.Helper()
	for _, item := range w.doc.GetItems() {
		if item.Type == ItemTypeToolAction && item.ToolUseID == toolUseID {
			return item.State
		}
	}
	t.Fatalf("no tool-action %q in the doc", toolUseID)
	return ""
}

// resultContentOf reads one tool-action's result content out of the worker's doc.
func resultContentOf(t *testing.T, w *ConversationWorker, toolUseID string) string {
	t.Helper()
	for _, item := range w.doc.GetItems() {
		if item.Type == ItemTypeToolAction && item.ToolUseID == toolUseID {
			var res struct {
				Content   string `json:"content"`
				Cancelled bool   `json:"cancelled"`
			}
			_ = json.Unmarshal(item.Result, &res)
			return res.Content
		}
	}
	t.Fatalf("no tool-action %q in the doc", toolUseID)
	return ""
}

// seedBatch appends an assistant message and the tool-actions it asked for, each
// unevaluated — the state every member of a batch starts in.
func seedBatch(w *ConversationWorker, toolUseIDs ...string) {
	w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeAssistant, ItemID: "a-1", Content: "Running some commands.",
	})
	for i, id := range toolUseIDs {
		w.doc.InsertMessage(i+1, ConversationItem{
			Type: ItemTypeToolAction, ItemID: "ta-" + id, ToolUseID: id,
			ToolName: "bash", State: StateUnevaluated,
		})
	}
}

// TestDenyCascade_RefusesCallsLeftUnstartedByADenial is the fault this exists
// for. A viewer denies the one call it can see; its siblings are still
// unevaluated, so the browser cascade cannot reach them. Left alone they are
// parked a moment later and the turn rests on prompts the user already refused.
func TestDenyCascade_RefusesCallsLeftUnstartedByADenial(t *testing.T) {
	h := newReattachHarness(t, "conv-deny-cascade")
	w := h.w
	seedBatch(w, "tu-1", "tu-2", "tu-3")

	// Baseline tick: nothing is cancelled yet, so nothing cascades.
	w.driveToolActions()
	if got := stateOf(t, w, "tu-2"); got != StateUnevaluated {
		t.Fatalf("baseline tick must not disturb an unevaluated call, got %q", got)
	}

	// The viewer denies the only call it had a prompt for.
	w.doc.UpdateToolActionFieldsRecursive("tu-1", map[string]any{
		"state":  StateCancelled,
		"result": map[string]any{"content": "Action was cancelled.", "cancelled": true, "isError": false},
	})

	w.driveToolActions()

	for _, id := range []string{"tu-2", "tu-3"} {
		if got := stateOf(t, w, id); got != StateCancelled {
			t.Fatalf("%s was left behind by the denial: state %q", id, got)
		}
		if got := resultContentOf(t, w, id); got != "Action was cancelled." {
			t.Fatalf("%s must carry the same result the browser writes, got %q", id, got)
		}
	}
}

// TestDenyCascade_RefusesAParkedSiblingAndSparesAnExecutingOne bounds the sweep.
// A parked sibling is refused for the same reason an unevaluated one is; a
// sibling already executing has a process behind it and belongs to the cancel
// path, which aborts the execution as well as writing the state.
func TestDenyCascade_RefusesAParkedSiblingAndSparesAnExecutingOne(t *testing.T) {
	h := newReattachHarness(t, "conv-deny-cascade-bounds")
	w := h.w
	seedBatch(w, "tu-denied", "tu-parked", "tu-running", "tu-done")
	w.doc.UpdateToolActionFieldsRecursive("tu-parked", map[string]any{"state": StatePending})
	w.doc.UpdateToolActionFieldsRecursive("tu-running", map[string]any{"state": StateRunning})
	w.doc.UpdateToolActionFieldsRecursive("tu-done", map[string]any{
		"state":  StateCompleted,
		"result": map[string]any{"content": "ok"},
	})

	w.driveToolActions() // baseline

	w.doc.UpdateToolActionFieldsRecursive("tu-denied", map[string]any{
		"state":  StateCancelled,
		"result": map[string]any{"content": "Action was cancelled.", "cancelled": true},
	})
	w.driveToolActions()

	if got := stateOf(t, w, "tu-parked"); got != StateCancelled {
		t.Fatalf("a parked sibling must be refused with the batch, got %q", got)
	}
	if got := stateOf(t, w, "tu-running"); got != StateRunning {
		t.Fatalf("an executing sibling belongs to the cancel path, got %q", got)
	}
	if got := stateOf(t, w, "tu-done"); got != StateCompleted {
		t.Fatalf("a settled sibling must be untouched, got %q", got)
	}
	if got := resultContentOf(t, w, "tu-done"); got != "ok" {
		t.Fatalf("a settled sibling must keep its result, got %q", got)
	}
}

// TestDenyCascade_LeavesACallResetForAFreshAskAlone is why the sweep is
// edge-triggered. handleRetryToolApproval re-asks a call by resetting it to
// unevaluated in place; a standing "a cancelled sibling refuses the rest" rule
// would cancel that re-ask on the very next tick, and the question would never
// be put again.
func TestDenyCascade_LeavesACallResetForAFreshAskAlone(t *testing.T) {
	h := newReattachHarness(t, "conv-deny-cascade-retry")
	w := h.w
	seedBatch(w, "tu-1", "tu-2")

	w.driveToolActions() // baseline
	w.doc.UpdateToolActionFieldsRecursive("tu-1", map[string]any{
		"state":  StateCancelled,
		"result": map[string]any{"content": "Action was cancelled.", "cancelled": true},
	})
	w.driveToolActions()
	if got := stateOf(t, w, "tu-2"); got != StateCancelled {
		t.Fatalf("precondition: the cascade should have refused tu-2, got %q", got)
	}

	// The user re-asks tu-2 (the AskUserQuestion re-ask path).
	w.doc.UpdateToolActionFieldsRecursive("tu-2", map[string]any{
		"state":  StateUnevaluated,
		"result": nil,
	})

	w.driveToolActions()

	if got := stateOf(t, w, "tu-2"); got != StateUnevaluated {
		t.Fatalf("a call reset for a fresh ask must survive the next tick, got %q", got)
	}
}

// TestDenyCascade_LoadingADeniedConversationCancelsNothing guards the first
// observation. A conversation loaded with a denial already in it had its cascade
// when the denial happened; re-running it against a doc whose calls may since
// have been retried would cancel work nobody refused.
//
// Note when reading a green run of this file: this is the one case here that
// also passes with the cascade removed entirely — it asserts that nothing
// happens. The three above it fail without it, which is what proves the sweep is
// running at all.
func TestDenyCascade_LoadingADeniedConversationCancelsNothing(t *testing.T) {
	h := newReattachHarness(t, "conv-deny-cascade-load")
	w := h.w
	seedBatch(w, "tu-old-denial", "tu-reasked")
	w.doc.UpdateToolActionFieldsRecursive("tu-old-denial", map[string]any{
		"state":  StateCancelled,
		"result": map[string]any{"content": "Action was cancelled.", "cancelled": true},
	})

	// The worker's first sight of this doc.
	w.driveToolActions()

	if got := stateOf(t, w, "tu-reasked"); got != StateUnevaluated {
		t.Fatalf("a first load must record, not cascade, got %q", got)
	}
}

// TestDenyCascade_RefusesACallHeldBehindARunningWrite: a call the user approved
// but turn order is still holding back (tool_ordering.go) has not started, so a
// denial of its batch refuses it like any other unstarted call. Left alone it
// would run once the write ahead of it finished, after the user had said stop.
func TestDenyCascade_RefusesACallHeldBehindARunningWrite(t *testing.T) {
	h := newReattachHarness(t, "conv-deny-cascade-held")
	w := h.w
	insertToolBatch(t, w, "txn-1", []string{"tu-w", "tu-h", "tu-d"}, []string{"write", "write", "write"})
	setToolState(w, "tu-w", StateRunning)
	setToolState(w, "tu-d", StatePending)

	w.driveToolActions() // baseline
	h.flush(t)
	wantExecuted(t, h, "held behind the running write", map[string]int{"tu-h": 0})

	w.doc.UpdateToolActionFieldsRecursive("tu-d", map[string]any{
		"state":  StateCancelled,
		"result": map[string]any{"content": "Action was cancelled.", "cancelled": true},
	})
	w.driveToolActions()
	h.flush(t)

	if got := stateOf(t, w, "tu-h"); got != StateCancelled {
		t.Fatalf("a call held by turn order must be refused with its batch, got %q", got)
	}
	if got := resultContentOf(t, w, "tu-h"); got != "Action was cancelled." {
		t.Fatalf("the held call must carry the same result the browser writes, got %q", got)
	}
	if got := stateOf(t, w, "tu-w"); got != StateRunning {
		t.Fatalf("the running write belongs to the cancel path, got %q", got)
	}

	setToolState(w, "tu-w", StateCompleted)
	w.driveToolActions()
	h.flush(t)
	wantExecuted(t, h, "after the write finished", map[string]int{"tu-h": 0})
}

// TestDenyCascade_SparesAHeldCallAlreadyCommanded bounds the rule above to calls
// never sent. Held is recomputed every tick, so a call commanded while nothing
// was ahead of it can look held a tick later — here because an earlier parked
// call was approved before the engine claimed this one. execute-tool has gone
// out for it, so it belongs to the cancel path, not to a doc write that could
// race the engine's claim.
func TestDenyCascade_SparesAHeldCallAlreadyCommanded(t *testing.T) {
	h := newReattachHarness(t, "conv-deny-cascade-commanded")
	w := h.w
	insertToolBatch(t, w, "txn-1", []string{"tu-a", "tu-b", "tu-c"}, []string{"write", "write", "write"})
	setToolState(w, "tu-a", StatePending)
	setToolState(w, "tu-c", StatePending)

	w.driveToolActions() // baseline; a parked call holds nothing, so tu-b is commanded
	h.flush(t)
	wantExecuted(t, h, "commanded past a parked call", map[string]int{"tu-b": 1})

	setToolState(w, "tu-a", StateApproved) // tu-b now looks held, but was sent
	w.doc.UpdateToolActionFieldsRecursive("tu-c", map[string]any{
		"state":  StateCancelled,
		"result": map[string]any{"content": "Action was cancelled.", "cancelled": true},
	})
	w.driveToolActions()
	h.flush(t)

	if got := stateOf(t, w, "tu-b"); got != StateApproved {
		t.Fatalf("a call already commanded belongs to the cancel path, got %q", got)
	}
}
