//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"testing"
)

// jsonOf renders a value the way the doc stores it, for comparing maps whose
// numbers may come back as a different numeric kind.
func jsonOf(t *testing.T, v any) string {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal %#v: %v", v, err)
	}
	return string(data)
}

// TestRunEntryRoundTripKeepsWhatItDoesNotKnow pins the CRDT boundary: a
// transition on one thread's entry writes that entry back with every key it
// was read with, including keys this worker has no accessor for, and leaves a
// sibling's entry exactly as it was.
func TestRunEntryRoundTripKeepsWhatItDoesNotKnow(t *testing.T) {
	w := NewConversationWorker("test-run-entry-roundtrip", "user:test")
	sibling := map[string]any{
		"activity":     ActivityAwaitingLLM,
		"threadItemId": "msg_sibling",
		"claimedAt":    int64(5),
		"status":       "processing_tools",
		"futureField":  map[string]any{"nested": []any{"a", 1.5}},
	}
	w.doc.SetMetadata("processingState", map[string]any{
		"activity":     ActivityCallingLLM,
		"threadItemId": "",
		"runs": map[string]any{
			rootRunKey: map[string]any{
				"activity":     ActivityCallingLLM,
				"threadItemId": "",
				"claimedAt":    int64(9),
				"status":       "streaming",
				"futureField":  "kept",
			},
			"msg_sibling": sibling,
		},
	})

	w.markExplicitContinuation("")

	state := w.readProcessingState()
	root := runEntryOf(state, "")
	if got, _ := root["futureField"].(string); got != "kept" {
		t.Errorf("the root entry lost a key it has no accessor for: %#v", root)
	}
	if !root.explicitContinuation() {
		t.Errorf("the transition did not land on the root entry: %#v", root)
	}
	if root.claimedAt() != 9 || root.status() != statusStreaming || root.activity() != ActivityCallingLLM {
		t.Errorf("the root entry's own fields changed: %#v", root)
	}
	if got, want := jsonOf(t, runEntryOf(state, "msg_sibling")), jsonOf(t, sibling); got != want {
		t.Errorf("a transition on the root rewrote its sibling:\n got %s\nwant %s", got, want)
	}
}

// TestRunEntryAccessors pins what the accessors read from the shapes the doc
// hands back, and the presence rules the client depends on.
func TestRunEntryAccessors(t *testing.T) {
	t.Run("a nil entry reads as no claim", func(t *testing.T) {
		var e runEntry
		if e.activity() != ActivityNone || e.claimedAt() != 0 || e.explicitContinuation() || e.hasStatus() || e.isLive() {
			t.Errorf("nil entry: activity=%q claimedAt=%d explicit=%v hasStatus=%v live=%v",
				e.activity(), e.claimedAt(), e.explicitContinuation(), e.hasStatus(), e.isLive())
		}
		if !e.isSpent() {
			t.Error("a nil entry must be spent, so it is never stored")
		}
	})

	t.Run("claimedAt reads every numeric kind a round trip produces", func(t *testing.T) {
		for _, v := range []any{int64(42), float64(42), 42} {
			if got := (runEntry{runFieldClaimedAt: v}).claimedAt(); got != 42 {
				t.Errorf("claimedAt from %T = %d, want 42", v, got)
			}
		}
	})

	t.Run("status is stored as a plain string", func(t *testing.T) {
		e := runEntry{}
		e.setStatus(statusStreaming)
		if _, ok := e[runFieldStatus].(string); !ok {
			t.Errorf("status stored as %T; readers in the same transaction assert on string", e[runFieldStatus])
		}
		if !e.isLive() {
			t.Error("a streaming entry must be live")
		}
	})

	t.Run("clearing removes the key rather than zeroing it", func(t *testing.T) {
		e := runEntry{runFieldCode: "x", runFieldStartedAt: int64(1), runFieldPolitePending: true}
		e.setCode("")
		e.clearStartedAt()
		e.setPolitePending(false)
		e.setText(nil)
		for _, key := range []string{runFieldCode, runFieldStartedAt, runFieldPolitePending, runFieldText} {
			if _, present := e[key]; present {
				t.Errorf("%s is still present; the client reads presence, so it must be removed", key)
			}
		}
	})

	t.Run("mergeTokens leaves a count it was not given", func(t *testing.T) {
		e := runEntry{runFieldInputTokens: 10}
		e.mergeTokens(3, 0, 0)
		if e[runFieldInputTokens] != 10 || e[runFieldOutputTokens] != 3 {
			t.Errorf("after mergeTokens(3, 0, 0): %#v", e)
		}
	})
}
