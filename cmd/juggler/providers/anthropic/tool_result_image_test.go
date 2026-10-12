//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package anthropic

import (
	"encoding/base64"
	"encoding/json"
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

func imageResult(id string, data []byte) provider.Message {
	return provider.Message{Type: "tool-result", ToolUseID: id, Content: "Read image " + id + ".png", Parts: []provider.MediaPart{
		{Type: "image", Mime: "image/png", Data: data},
	}}
}

// TestToolResultNestsImageBlock: a tool-result with image parts carries the
// image inside its own tool_result block, after the tool's text.
func TestToolResultNestsImageBlock(t *testing.T) {
	data := []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a}
	msgs := []provider.Message{
		{Type: "assistant", Content: "let me look"},
		{Type: "tool-use", ToolUseID: "t1", ToolName: "read", ToolInput: map[string]any{"file_path": "t1.png"}},
		imageResult("t1", data),
	}

	out := TransformToAPIMessages(msgs)

	last := out[len(out)-1]
	if len(last.Content) != 1 || last.Content[0].Type != "tool_result" {
		t.Fatalf("user turn = %+v, want exactly one tool_result block", last.Content)
	}
	inner := last.Content[0].ContentBlocks
	if len(inner) != 2 || inner[0].Type != "text" || inner[0].Text != "Read image t1.png" {
		t.Fatalf("tool_result content = %+v, want [text, image]", inner)
	}
	if img := inner[1]; img.Type != "image" || img.Source == nil || img.Source.MediaType != "image/png" ||
		img.Source.Data != base64.StdEncoding.EncodeToString(data) {
		t.Fatalf("inner[1] = %+v, want the base64 PNG", inner[1])
	}
}

// TestParallelImageResultsKeepToolResultsFirst: two parallel reads that both
// returned images must not interleave [tool_result, image, tool_result, image]
// — the API rejects a tool_result that follows other content in a user turn.
func TestParallelImageResultsKeepToolResultsFirst(t *testing.T) {
	data := []byte{0x89, 0x50, 0x4e, 0x47}
	msgs := []provider.Message{
		{Type: "tool-use", ToolUseID: "a", ToolName: "read", ToolInput: map[string]any{"file_path": "a.png"}},
		{Type: "tool-use", ToolUseID: "b", ToolName: "read", ToolInput: map[string]any{"file_path": "b.png"}},
		imageResult("a", data),
		imageResult("b", data),
	}

	for _, m := range TransformToAPIMessagesForCLI(msgs) {
		seenOther := false
		for _, b := range m.Content {
			if b.Type != "tool_result" {
				seenOther = true
			} else if seenOther {
				t.Fatalf("tool_result %q follows non-tool_result content: %+v", b.ToolUseID, m.Content)
			}
		}
	}
}

// TestToolResultImageMarshalsAsContentArray: on the CLI path the block is
// serialized directly, so the nested content must reach the wire as the
// tool_result's `content` array.
func TestToolResultImageMarshalsAsContentArray(t *testing.T) {
	out := TransformToAPIMessagesForCLI([]provider.Message{
		{Type: "tool-use", ToolUseID: "t1", ToolName: "read", ToolInput: map[string]any{}},
		imageResult("t1", []byte{1, 2, 3}),
	})
	raw, err := json.Marshal(out[len(out)-1].Content[0])
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		Type    string `json:"type"`
		Content []struct {
			Type   string `json:"type"`
			Source *struct {
				MediaType string `json:"media_type"`
			} `json:"source"`
		} `json:"content"`
	}
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("content is not an array of blocks: %s", raw)
	}
	if got.Type != "tool_result" || len(got.Content) != 2 || got.Content[1].Type != "image" ||
		got.Content[1].Source == nil || got.Content[1].Source.MediaType != "image/png" {
		t.Fatalf("marshalled tool_result = %s, want content [text, image]", raw)
	}
}

// TestToolResultImageReachesSDK: the SDK path maps the nested image into the
// tool_result's content union rather than dropping it.
func TestToolResultImageReachesSDK(t *testing.T) {
	out := TransformToAPIMessages([]provider.Message{
		{Type: "tool-use", ToolUseID: "t1", ToolName: "read", ToolInput: map[string]any{}},
		imageResult("t1", []byte{1, 2, 3}),
	})
	sdk := convertBlockToSDK(out[len(out)-1].Content[0])
	if sdk == nil || sdk.OfToolResult == nil {
		t.Fatalf("converted block = %+v, want a tool_result", sdk)
	}
	content := sdk.OfToolResult.Content
	if len(content) != 2 || content[0].OfText == nil || content[0].OfText.Text != "Read image t1.png" ||
		content[1].OfImage == nil || content[1].OfImage.Source.OfBase64 == nil {
		t.Fatalf("tool_result content = %+v, want [text, base64 image]", content)
	}
}

// TestToolResultWithoutImageHasNoImageBlock: a text-only tool result emits no
// image blocks (behaviour unchanged for non-image tools).
func TestToolResultWithoutImageHasNoImageBlock(t *testing.T) {
	msgs := []provider.Message{
		{Type: "tool-use", ToolUseID: "t1", ToolName: "read", ToolInput: map[string]any{}},
		{Type: "tool-result", ToolUseID: "t1", Content: "plain text"},
	}
	for _, m := range TransformToAPIMessages(msgs) {
		for _, b := range m.Content {
			if b.Type == "image" || len(b.ContentBlocks) > 0 {
				t.Fatalf("unexpected image content for a text-only tool result: %+v", b)
			}
		}
	}
}
