//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"slices"
	"strings"

	"juggler/cmd/juggler/providers/provider"
)

// The claude CLI cuts every MCP tool description at about 2,048 characters and
// appends "… [truncated]". Nothing reports it: the model simply never sees the
// rest. Measured against CLI 2.1.284 by asking the model to quote the end of a
// 14,703-character description; it saw the first 2,045 characters.
//
// So a description over the cap is folded: the tool keeps its opening, plus a
// pointer, and the whole text moves into the system prompt under a heading the
// pointer names. The model gets every word, once.
//
// maxCLIToolDescription is in bytes, below the measured cut. The CLI counts
// UTF-16 code units, and a byte count is never smaller than that, so a
// description that fits here fits there.
const maxCLIToolDescription = 2000

// toolReferenceHeading is the system-prompt heading a folded tool's whole
// description sits under, and the text its pointer quotes. It names the tool as
// the model must call it, with the CLI's prefix: titled by bare names, the
// section read as a list of more tools, and Opus called `query_code` and `bash`
// unprefixed from its first call in 3 of 4 runs, which the CLI refuses.
func toolReferenceHeading(name string) string {
	return "## Tool reference: " + mcpToolPrefix + name
}

const toolReferencePreamble = "# Tool reference\n\n" +
	"These are the whole descriptions of tools you already have, whose entries in your tool list are shortened. " +
	"They are documentation, not more tools. Call every tool by its full name from your tool list, which begins with " +
	mcpToolPrefix + "; a name written without that prefix anywhere below is not a tool you can call."

// foldLongToolDescriptions returns req with every description over the CLI's
// cap folded into the system prompt. A request with none is returned unchanged,
// byte for byte, so ordinary sessions hash as they always have. The fold is
// deterministic, so the same tools give the same system prompt every turn and a
// warm session stays warm.
//
// req.Tools is copied before it is changed: the slice belongs to the caller.
func foldLongToolDescriptions(req provider.MessageRequest) provider.MessageRequest {
	if !slices.ContainsFunc(req.Tools, func(t provider.ToolDefinition) bool {
		return len(t.Description) > maxCLIToolDescription
	}) {
		return req
	}

	tools := slices.Clone(req.Tools)
	var reference strings.Builder
	reference.WriteString(toolReferencePreamble)
	for i, t := range tools {
		if len(t.Description) <= maxCLIToolDescription {
			continue
		}
		heading := toolReferenceHeading(t.Name)
		reference.WriteString("\n\n" + heading + "\n\n" + t.Description)
		tools[i].Description = foldedDescription(t.Description, heading)
	}

	req.Tools = tools
	if req.SystemPrompt == "" {
		req.SystemPrompt = reference.String()
	} else {
		req.SystemPrompt += "\n\n" + reference.String()
	}
	return req
}

// foldedDescription is what the tool list carries for a folded tool: as many of
// its opening paragraphs as fit, then the pointer. A first paragraph too long
// to fit on its own is cut at a word.
func foldedDescription(full, heading string) string {
	pointer := "\n\n(This description continues in full in the system prompt, under \"" + heading + "\".)"
	room := maxCLIToolDescription - len(pointer)

	var head string
	for _, para := range strings.Split(full, "\n\n") {
		next := para
		if head != "" {
			next = head + "\n\n" + para
		}
		if len(next) > room {
			break
		}
		head = next
	}
	if head == "" {
		head = full[:room-len(" …")]
		if cut := strings.LastIndexAny(head, " \n"); cut > room/2 {
			head = head[:cut]
		}
		head = strings.ToValidUTF8(head, "") + " …"
	}
	return head + pointer
}
