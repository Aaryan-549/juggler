//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
)

// maxProgramChangeLines is the longest list of changes a program's tool_result
// carries before the rest are counted instead of listed.
const maxProgramChangeLines = 50

// programCallRecord is one entry of a program tool's call record
// (displayData.nestedCalls, see SCHEMA.md), as much of it as the report needs.
// Effect is set only on a call that changes things and actually ran.
type programCallRecord struct {
	Status string `json:"status"`
	Effect string `json:"effect"`
}

// programChangeReport renders the changes a program tool made, for the
// model, from the call record the engine keeps on the program's tool-action
// while it runs. Reads are never listed; every call that changes things is, one
// line each, noted when it failed or never finished. Empty when the item has no
// record or the record holds no change.
//
// It is built here, in the wire projection, rather than by the program, so the
// model is told what changed however the program ended. A program the user
// stops, or one whose engine dies, never produces a result of its own — the
// worker writes the cancelled or failed state, and the record on displayData is
// the only account of what ran. The same text is mirrored for the UI's token
// estimate in web/js/utils/program-changes.js.
func programChangeReport(displayData json.RawMessage) string {
	// Every tool-action's displayData passes through here on every projection,
	// and only a program tool's holds a record: skip the parse for the rest.
	if !bytes.Contains(displayData, []byte(`"nestedCalls"`)) {
		return ""
	}
	var record struct {
		NestedCalls    []programCallRecord `json:"nestedCalls"`
		OmittedEffects int                 `json:"omittedEffects"`
	}
	if err := json.Unmarshal(displayData, &record); err != nil {
		return ""
	}
	var lines []string
	for _, c := range record.NestedCalls {
		if c.Effect == "" {
			continue
		}
		note := ""
		switch c.Status {
		case "ok":
		case "error":
			note = " (failed)"
		default:
			note = " (interrupted)"
		}
		lines = append(lines, c.Effect+note)
	}
	extra := record.OmittedEffects
	if len(lines) > maxProgramChangeLines {
		extra += len(lines) - maxProgramChangeLines
		lines = lines[:maxProgramChangeLines]
	}
	if len(lines) == 0 && extra == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("\n\nChanges the program made:")
	for _, l := range lines {
		b.WriteString("\n- ")
		b.WriteString(l)
	}
	if extra > 0 {
		fmt.Fprintf(&b, "\n…and %d more", extra)
	}
	return b.String()
}
