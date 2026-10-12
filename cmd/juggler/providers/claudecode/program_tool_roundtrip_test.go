//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// A program tool over the Claude Code CLI. It reaches the model through MCP
// rather than an API tool list, so the three things a program depends on cross
// a transport no other provider has: its description (which carries the
// generated SDK), the program text in its argument, and its result (the
// program's value followed by the changes it made). Each must arrive exactly as
// it was sent — the description as long as it fits the CLI's cap; a longer one
// is folded into the system prompt (long_tool_descriptions.go).

package claudecode

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// programSDKDescription is a program tool's description with an SDK attached, in the
// shape the engine renders: JSDoc comments, backticks and template-literal
// syntax, across many lines.
const programSDKDescription = "Run a JavaScript program that calls tools. Only what you return enters the conversation, " +
	"plus a list of any changes the program made. Read and search with `fs`, `grep` and `glob`; act with `tools.*`.\n\n" +
	"Callable as `await tools.<name>({...})`. Each resolves to the tool's result text.\n\n" +
	"/**\n * Edit a file by replacing text <exactly> & once.\n * @param {object} args\n" +
	" * @param {string} args.file_path - Path, e.g. `src/${name}.js`\n" +
	" * @returns {Promise<string>} The tool's result text\n */\ntools.edit(args)"

// TestProgramToolDefinitionReachesClaudeCodeIntact: the tools/list entry for
// a program tool carries its name unprefixed and its SDK description and schema
// unchanged.
func TestProgramToolDefinitionReachesClaudeCodeIntact(t *testing.T) {
	schema := json.RawMessage(`{"type":"object","properties":{"code":{"type":"string","description":"JavaScript to execute"}},"required":["code"]}`)
	raws, err := toolDefsToMCPList([]provider.ToolDefinition{
		{Name: "program_tool", Description: programSDKDescription, InputSchema: schema},
	})
	if err != nil {
		t.Fatalf("toolDefsToMCPList: %v", err)
	}
	if len(raws) != 1 {
		t.Fatalf("the program tool must be advertised, got %d tools", len(raws))
	}
	var got struct {
		Name        string          `json:"name"`
		Description string          `json:"description"`
		InputSchema json.RawMessage `json:"inputSchema"`
	}
	if err := json.Unmarshal(raws[0], &got); err != nil {
		t.Fatalf("decode advertised tool: %v", err)
	}
	if got.Name != "program_tool" {
		t.Errorf("advertised name = %q, want program_tool (the CLI adds its own prefix)", got.Name)
	}
	if got.Description != programSDKDescription {
		t.Errorf("the SDK description changed in transit:\n got %q\nwant %q", got.Description, programSDKDescription)
	}
	var gotSchema, wantSchema any
	if err := json.Unmarshal(got.InputSchema, &gotSchema); err != nil {
		t.Fatalf("decode advertised schema: %v", err)
	}
	_ = json.Unmarshal(schema, &wantSchema)
	if !reflect.DeepEqual(gotSchema, wantSchema) {
		t.Errorf("input schema changed in transit: got %s", got.InputSchema)
	}
}

// TestProgramToolRoundTripsThroughClaudeCode drives one program tool call through a
// real fake CLI subprocess: the program text the model wrote reaches the worker
// unchanged, and the result the worker feeds back — value, then the change
// list — reaches the CLI byte for byte.
func TestProgramToolRoundTripsThroughClaudeCode(t *testing.T) {
	code := "const a = await fs.readFile(\"src/a.js\");\n" +
		"// “curly” ‘quotes’, a `tick` and ${not.a.template}\n" +
		"await tools.edit({ file_path: 'src/a.js', old_string: \"x\\ny\", new_string: 'ü → ✓' });\n" +
		"return { ok: true, n: a.length };"
	result := "{\n  \"ok\": true,\n  \"n\": 42\n}\n\n" +
		"Changes the program made:\n- edit: src/a.js\n- bash: printf \"done\" > out.txt"

	tapePath := installScriptedFake(t, fakeScript{Turns: []scriptTurn{{
		Calls: []scriptCall{{ID: "rc1", Name: "program_tool", UseArgs: map[string]any{"code": code}}},
	}}})
	c := mkClient(t, "claude-sonnet-4-6")

	var uses []provider.StreamChunk
	record := func(chunk provider.StreamChunk) (*provider.ToolResult, error) {
		if chunk.Type == provider.ContentBlockTypeToolUse {
			uses = append(uses, chunk)
		}
		return nil, nil
	}
	send := func(msgs []provider.Message) *provider.StreamResult {
		t.Helper()
		res, err := c.streamMessage(context.Background(), provider.MessageRequest{
			ConversationID: "conv-program-tool", SystemPrompt: "sys", Messages: msgs,
		}, record)
		if err != nil {
			t.Fatalf("streamMessage: %v", err)
		}
		return res
	}

	convo := []provider.Message{userMsg("swap the greeting")}
	if res := send(convo); res.StopReason != "tool_use" {
		t.Fatalf("StopReason = %q, want tool_use", res.StopReason)
	}
	if len(uses) != 1 {
		t.Fatalf("expected one tool_use for the worker, got %d", len(uses))
	}
	if uses[0].ToolName != "program_tool" || uses[0].ToolUseID != "rc1" {
		t.Errorf("tool_use = %s/%s, want program_tool/rc1 with the MCP prefix stripped", uses[0].ToolName, uses[0].ToolUseID)
	}
	if got, _ := uses[0].ToolInput["code"].(string); got != code {
		t.Errorf("the program changed in transit:\n got %q\nwant %q", got, code)
	}

	convo = append(convo, toolUseMsg("rc1", "program_tool"), toolResultMsg("rc1", result))
	if res := send(convo); res.StopReason != "end_turn" {
		t.Fatalf("after the result, StopReason = %q, want end_turn", res.StopReason)
	}
	c.dropSession("conv-program-tool")

	var answers []string
	for _, r := range readTape(t, tapePath) {
		if r.Event == "answer" {
			answers = append(answers, r.Text)
		}
	}
	if len(answers) != 1 {
		t.Fatalf("expected the CLI to receive one result, got %d: %q", len(answers), answers)
	}
	if answers[0] != result {
		t.Errorf("the result changed in transit:\n got %q\nwant %q", answers[0], result)
	}
}
