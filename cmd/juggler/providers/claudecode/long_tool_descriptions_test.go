//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// longDescription builds a multi-paragraph description well past the CLI's cut,
// with a distinct line at the very end so a test can tell whether the end
// survived.
func longDescription(lead string, size int) string {
	var b strings.Builder
	b.WriteString(lead + "\n\nCallable as `await tools.<name>({...})`.")
	for i := 0; b.Len() < size; i++ {
		b.WriteString("\n\n/**\n * Tool number " + strings.Repeat("x", 60) + "\n * @param {object} args\n */\ntools.t" + string(rune('a'+i%26)) + "(args)")
	}
	b.WriteString("\n\ntools.the_very_last_entry(args)")
	return b.String()
}

var objectSchema = json.RawMessage(`{"type":"object","properties":{}}`)

func TestFoldLongToolDescriptions_LeavesAnOrdinaryRequestAlone(t *testing.T) {
	req := provider.MessageRequest{
		SystemPrompt: "sys",
		Tools: []provider.ToolDefinition{
			{Name: "read", Description: "Read a file.", InputSchema: objectSchema},
			{Name: "edit", Description: strings.Repeat("e", maxCLIToolDescription), InputSchema: objectSchema},
		},
	}
	got := foldLongToolDescriptions(req)
	// Byte-identical, so the session hashes of every ordinary conversation are
	// what they were.
	if got.SystemPrompt != req.SystemPrompt {
		t.Errorf("system prompt changed with no long tool: %q", got.SystemPrompt)
	}
	for i := range req.Tools {
		if got.Tools[i].Description != req.Tools[i].Description {
			t.Errorf("%s: a description at or under the cap was rewritten", req.Tools[i].Name)
		}
	}
}

func TestFoldLongToolDescriptions_MovesTheWholeTextIntoTheSystemPrompt(t *testing.T) {
	runCode := longDescription("Run a JavaScript program that calls tools.", 14000)
	pin := longDescription("Attach something to the user's Pinboard.", maxCLIToolDescription+50)
	req := provider.MessageRequest{
		SystemPrompt: "sys",
		Tools: []provider.ToolDefinition{
			{Name: "read", Description: "Read a file.", InputSchema: objectSchema},
			{Name: "run_code", Description: runCode, InputSchema: objectSchema},
			{Name: "pin_to_pinboard", Description: pin, InputSchema: objectSchema},
		},
	}
	got := foldLongToolDescriptions(req)

	if req.Tools[1].Description != runCode {
		t.Fatal("the caller's tool list was mutated; it is shared with the worker")
	}
	if got.Tools[0].Description != "Read a file." {
		t.Errorf("a short description was rewritten: %q", got.Tools[0].Description)
	}
	for _, tool := range got.Tools[1:] {
		if n := len(tool.Description); n > maxCLIToolDescription {
			t.Errorf("%s: folded description is %d bytes, over the %d the CLI keeps", tool.Name, n, maxCLIToolDescription)
		}
		if !strings.Contains(tool.Description, toolReferenceHeading(tool.Name)) {
			t.Errorf("%s: the folded description does not say where the rest is:\n%s", tool.Name, tool.Description)
		}
	}
	if !strings.HasPrefix(got.Tools[1].Description, "Run a JavaScript program that calls tools.") {
		t.Errorf("the folded description must open with the tool's own opening:\n%s", got.Tools[1].Description)
	}

	if !strings.HasPrefix(got.SystemPrompt, "sys") {
		t.Errorf("the original system prompt must come first:\n%.200s", got.SystemPrompt)
	}
	for _, want := range []struct{ name, text string }{{"run_code", runCode}, {"pin_to_pinboard", pin}} {
		section := toolReferenceHeading(want.name) + "\n\n" + want.text
		if !strings.Contains(got.SystemPrompt, section) {
			t.Errorf("the system prompt lacks %s's whole description under its heading", want.name)
		}
	}
	// The section must not read as a list of more tools. With it titled by bare
	// names, Opus called `query_code` and `bash` unprefixed from its first call
	// in 3 of 4 runs, which the CLI refuses ("No such tool available"). So each
	// tool is titled by the name it is called by, and the rule is stated.
	for _, want := range []string{
		"## Tool reference: mcp__juggler__run_code",
		"## Tool reference: mcp__juggler__pin_to_pinboard",
		"Call every tool by its full name from your tool list, which begins with mcp__juggler__",
	} {
		if !strings.Contains(got.SystemPrompt, want) {
			t.Errorf("the system prompt must say %q", want)
		}
	}
	if strings.Count(got.SystemPrompt, "tools.the_very_last_entry(args)") != 2 {
		t.Error("each long description's last line must reach the model exactly once")
	}

	// Deterministic: the same request folds to the same bytes, or every turn
	// would look like an edited system prompt and cold-start the session.
	if again := foldLongToolDescriptions(req); again.SystemPrompt != got.SystemPrompt {
		t.Error("folding the same request twice gave different system prompts")
	}
}

// TestLongToolDescriptionsReachTheCLIFolded drives a real fake-CLI subprocess
// and reads back what the session actually served on tools/list and spawned
// with as its system prompt.
func TestLongToolDescriptionsReachTheCLIFolded(t *testing.T) {
	runCode := longDescription("Run a JavaScript program that calls tools.", 14000)
	installScriptedFake(t, fakeScript{Turns: []scriptTurn{{}}})
	c := mkClient(t, "claude-sonnet-4-6")

	req := provider.MessageRequest{
		ConversationID: "conv-long-desc", SystemPrompt: "sys",
		Messages: []provider.Message{userMsg("hello")},
		Tools:    []provider.ToolDefinition{{Name: "run_code", Description: runCode, InputSchema: objectSchema}},
	}
	if _, err := c.streamMessage(context.Background(), req, func(provider.StreamChunk) (*provider.ToolResult, error) { return nil, nil }); err != nil {
		t.Fatalf("streamMessage: %v", err)
	}
	defer c.dropSession("conv-long-desc")

	if c.activeSession == nil || c.activeSession.live == nil || c.activeSession.live.control == nil {
		t.Fatal("no live session to inspect")
	}
	served, err := c.activeSession.live.control.tools()
	if err != nil || len(served) != 1 {
		t.Fatalf("tools/list served %d tools (%v)", len(served), err)
	}
	var def mcpToolDef
	if err := json.Unmarshal(served[0], &def); err != nil {
		t.Fatal(err)
	}
	if len(def.Description) > maxCLIToolDescription {
		t.Errorf("tools/list served a %d-byte description; the CLI cuts it at %d", len(def.Description), maxCLIToolDescription)
	}
	if got, want := c.activeSession.sentSystemHash, hashSystemPrompt(foldLongToolDescriptions(req).SystemPrompt); got != want {
		t.Error("the session was not started on the folded system prompt, so the full description never reached the model")
	}
}
