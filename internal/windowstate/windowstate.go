//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package windowstate holds the stored state of one native window. It sits
// below both its owner (the session, cmd/juggler/core, which persists it) and
// the window-geometry code (internal/windowgeom, shared by the two Wails
// hosts), so neither has to import the other for the type.
package windowstate

import (
	"encoding/json"
	"maps"
)

// State is one of a project's windows: the native geometry it was left in, and
// the look it was left wearing. It is session state (persisted in
// .juggler/session.json, where core knows it as core.WindowState) rather than a
// single machine-global file: keying it by project gives each project's windows
// their own slots with no cross-process write race, and reopening a project
// restores its windows as they were. Process-local; deliberately NOT part of
// the session's Metadata, so it is never sent to viewers or surfaced as a
// frontend flag.
//
// Theme and Zoom sit beside the frame because they are the same kind of fact
// about the same window: a board detached onto a second display is a window the
// user set up on purpose, and its appearance belongs to it rather than to
// whichever window last touched the project. Both are unset ("" / 0) until that
// window is told otherwise, and an unset one falls back to the project-wide
// UITheme/UIZoom — so a board nobody has restyled still follows the main window.
//
// UI is the same kind of fact again, one level less structured: the preferences
// the viewer keeps for this window (see core's ui_prefs.go). Nothing in Go reads
// them, so they are stored opaquely.
//
// Geometry writes never carry any of it: the frame is captured from the live
// native window (see windowgeom.Tracker.Capture) and knows nothing about
// appearance, so the session's SetWindowState preserves whatever is already
// stored.
type State struct {
	X          int                        `json:"x"`
	Y          int                        `json:"y"`
	Width      int                        `json:"width"`
	Height     int                        `json:"height"`
	HasPos     bool                       `json:"hasPos"`
	Maximised  bool                       `json:"maximised"`
	Fullscreen bool                       `json:"fullscreen"`
	Theme      string                     `json:"theme,omitempty"` // UI theme mode (system|light|dark) for this window; "" follows the project
	Zoom       int                        `json:"zoom,omitempty"`  // UI zoom (root font-size %) for this window; 0 follows the project
	UI         map[string]json.RawMessage `json:"ui,omitempty"`    // This window's UI preferences, stored verbatim (the client owns the shape); nil until one is set
}

// Clone returns a private copy of one window's slot. The UI map is the reason
// it exists: a map inside a struct value is copied by reference, so a caller
// handed the struct would share that map with whoever else holds a copy. The
// values are immutable bytes, so copying the map is a genuine copy; nil stays
// nil, so an untouched slot serialises without it.
func (ws State) Clone() State {
	ws.UI = maps.Clone(ws.UI)
	return ws
}

// SameFrame reports whether two slots describe the same native window frame,
// ignoring everything that is not geometry.
//
// It exists because State holds a map and so cannot be compared with ==. That
// is the useful outcome rather than an obstacle: almost every comparison is
// asking about the frame, and one that silently started including the viewer's
// preferences would answer a question nobody asked.
func (ws State) SameFrame(other State) bool {
	return ws.X == other.X && ws.Y == other.Y &&
		ws.Width == other.Width && ws.Height == other.Height &&
		ws.HasPos == other.HasPos &&
		ws.Maximised == other.Maximised && ws.Fullscreen == other.Fullscreen
}
