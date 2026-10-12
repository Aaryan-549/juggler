//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

// programItem is a program tool's tool-action as the document holds it once the
// program has ended: the result whoever wrote it, and the call record the
// engine kept on displayData while the program ran.
func programItem(t *testing.T, result string, calls []map[string]any, omittedEffects int) ConversationItem {
	t.Helper()
	display, err := json.Marshal(map[string]any{"nestedCalls": calls, "omitted": 0, "omittedEffects": omittedEffects})
	if err != nil {
		t.Fatal(err)
	}
	return ConversationItem{
		ToolUseID:   "prog_1",
		ToolName:    "program_tool",
		Result:      json.RawMessage(result),
		DisplayData: display,
	}
}

// TestProgramChangeReportOnCancel pins invariant 3 where it was open: a program
// the user stopped leaves only the worker's "cancelled" result, and the model
// must still be told what the program changed before it stopped — including the
// call that was cut off mid-run. Reads are never listed.
func TestProgramChangeReportOnCancel(t *testing.T) {
	// The content CancelInFlightToolActions writes for a call stopped mid-run.
	item := programItem(t, `{"content":"Interrupted","isError":false}`, []map[string]any{
		{"name": "bash", "status": "ok", "effect": "bash: printf done > out.txt"},
		{"name": "read", "status": "ok", "args": map[string]any{"file_path": "a.txt"}},
		{"name": "bash", "status": "cancelled", "effect": "bash: sleep 30"},
	}, 0)
	m := buildToolResultMap(item)
	want := "Interrupted\n\nChanges the program made:\n- bash: printf done > out.txt\n- bash: sleep 30 (interrupted)"
	if m["content"] != want {
		t.Errorf("content =\n%q\nwant\n%q", m["content"], want)
	}
	if m["isError"] != false {
		t.Errorf("isError = %v, want the result's own verdict untouched", m["isError"])
	}
}

// TestProgramChangeReportMarksHowEachCallEnded pins the per-line note: a call
// that finished says nothing, one that failed says so, and one that never
// finished is interrupted.
func TestProgramChangeReportMarksHowEachCallEnded(t *testing.T) {
	item := programItem(t, `{"content":"{\"n\": 2}","isError":false}`, []map[string]any{
		{"name": "edit", "status": "ok", "effect": "edit: src/a.js"},
		{"name": "bash", "status": "error", "effect": "bash: npm test", "error": "exit 1"},
		{"name": "bash", "status": "running", "effect": "bash: make"},
	}, 0)
	want := "{\"n\": 2}\n\nChanges the program made:\n- edit: src/a.js\n- bash: npm test (failed)\n- bash: make (interrupted)"
	if got := buildToolResultMap(item)["content"]; got != want {
		t.Errorf("content =\n%q\nwant\n%q", got, want)
	}
}

// TestProgramChangeReportIsCapped pins the bound: fifty lines, then a count of
// the rest, which includes the effects the record itself had to give up.
func TestProgramChangeReportIsCapped(t *testing.T) {
	var calls []map[string]any
	for i := range 52 {
		calls = append(calls, map[string]any{"name": "edit", "status": "ok", "effect": fmt.Sprintf("edit: f%d.js", i)})
	}
	item := programItem(t, `{"content":"done","isError":false}`, calls, 3)
	content, _ := buildToolResultMap(item)["content"].(string)
	lines := strings.Split(content, "\n")
	if got := lines[len(lines)-1]; got != "…and 5 more" {
		t.Errorf("last line = %q, want %q", got, "…and 5 more")
	}
	if !strings.Contains(content, "- edit: f49.js\n…and 5 more") || strings.Contains(content, "f50.js") {
		t.Errorf("want exactly the first fifty listed:\n%s", content)
	}
}

// TestProgramChangeReportPrecedesHookNotes pins the order inside the
// tool_result: the program's result, what it changed, then what hooks said.
func TestProgramChangeReportPrecedesHookNotes(t *testing.T) {
	item := programItem(t, `{"content":"done","isError":false}`, []map[string]any{
		{"name": "edit", "status": "ok", "effect": "edit: a.js"},
	}, 0)
	item.Hooks = json.RawMessage(`[{"id":"h","event":"afterTool","note":"A note."}]`)
	want := "done\n\nChanges the program made:\n- edit: a.js\n\n<hook-note source=\"h\">\nA note.\n</hook-note>"
	if got := buildToolResultMap(item)["content"]; got != want {
		t.Errorf("content =\n%q\nwant\n%q", got, want)
	}
}

// TestProgramChangeReportAbsentLeavesContentUnchanged pins byte-stability: a
// tool-action with no call record, or a record of reads only, projects exactly
// as before — the prompt-cache prefix of every conversation depends on it.
func TestProgramChangeReportAbsentLeavesContentUnchanged(t *testing.T) {
	for _, display := range []string{
		"",
		`{"output":"partial"}`,
		`{"nestedCalls":[]}`,
		`{"nestedCalls":[{"name":"read","status":"ok"}],"omitted":4}`,
		`{"nestedCalls":"not a list"}`,
		`not json`,
	} {
		item := ConversationItem{ToolUseID: "t", Result: json.RawMessage(`{"content":"ok","isError":false}`)}
		if display != "" {
			item.DisplayData = json.RawMessage(display)
		}
		if got := buildToolResultMap(item)["content"]; got != "ok" {
			t.Errorf("displayData %s: content = %q, want %q", display, got, "ok")
		}
	}
}
