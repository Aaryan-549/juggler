//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"testing"

	ycrdt "github.com/skyterra/y-crdt"
)

// TestBuildToolResultMapAppendsHookNotes pins where a hook's note reaches the
// model: inside the call's own tool_result, after the tool's output, tagged with
// the hook that wrote it. Records that carry no note (a verdict, a hook that
// matched and said nothing) contribute nothing.
func TestBuildToolResultMapAppendsHookNotes(t *testing.T) {
	item := ConversationItem{
		ToolUseID: "tool_1",
		Result:    json.RawMessage(`{"content":"touch: /etc/x: Operation not permitted","isError":true}`),
		Hooks: json.RawMessage(`[
			{"id":"nono-denial","event":"afterTool","note":"Run nono why to diagnose."},
			{"id":"silent","event":"afterTool"},
			{"id":"second","event":"afterTool","note":"  Another note.  "}
		]`),
	}
	m := buildToolResultMap(item)
	want := "touch: /etc/x: Operation not permitted" +
		"\n\n<hook-note source=\"nono-denial\">\nRun nono why to diagnose.\n</hook-note>" +
		"\n\n<hook-note source=\"second\">\nAnother note.\n</hook-note>"
	if m["content"] != want {
		t.Errorf("content =\n%q\nwant\n%q", m["content"], want)
	}
	if m["isError"] != true {
		t.Errorf("isError = %v, want the tool's own verdict untouched", m["isError"])
	}
}

// TestHookNotesSurviveTheDocument pins the path a note actually takes: the
// engine writes `hooks` onto the tool-action's Y.Map, and the worker builds the
// tool_result from its own read of the doc. A field the doc reader does not
// copy never reaches the model, however correctly the record was stored.
func TestHookNotesSurviveTheDocument(t *testing.T) {
	w := NewConversationWorker("conv-hook-notes", "user:test")
	t.Cleanup(func() { w.doc.Destroy() })

	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		w.doc.ensureItems().Push(ycrdt.ArrayAny{ycrdt.NewYMap(map[string]any{
			"type":      ItemTypeToolAction,
			"itemId":    generateItemID(),
			"toolUseId": "tool_doc",
			"toolName":  "bash",
			"state":     StateCompleted,
			"result":    convertToYcrdt(map[string]any{"content": "Operation not permitted", "isError": true}),
			"hooks": convertToYcrdt([]any{
				map[string]any{"id": "nono-denial", "event": "afterTool", "note": "Run nono why."},
			}),
		})})
	}, w.doc.authorID)

	items := w.doc.GetItemsFromArray(w.doc.ensureItems())
	if len(items) != 1 {
		t.Fatalf("items = %d, want 1", len(items))
	}
	want := "Operation not permitted\n\n<hook-note source=\"nono-denial\">\nRun nono why.\n</hook-note>"
	if got := toolResultWire(items[0])["content"]; got != want {
		t.Errorf("content =\n%q\nwant\n%q", got, want)
	}
}

// TestBuildToolResultMapWithoutHooksIsUnchanged pins that a call no hook spoke
// on projects byte-identically to one from before hooks existed — the prompt
// cache prefix of every existing conversation depends on it.
func TestBuildToolResultMapWithoutHooksIsUnchanged(t *testing.T) {
	for _, hooks := range []string{"", `[]`, `[{"id":"x","event":"beforeTool","verdict":"allow"}]`, `not json`} {
		item := ConversationItem{
			ToolUseID: "tool_2",
			Result:    json.RawMessage(`{"content":"ok","isError":false}`),
		}
		if hooks != "" {
			item.Hooks = json.RawMessage(hooks)
		}
		if got := buildToolResultMap(item)["content"]; got != "ok" {
			t.Errorf("hooks %s: content = %q, want %q", hooks, got, "ok")
		}
	}
}
