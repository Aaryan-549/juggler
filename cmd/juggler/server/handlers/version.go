//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"net/http"

	"juggler/cmd/juggler/core"
)

// VersionAPI serves GET /api/version.
type VersionAPI struct {
	protocolVersion int
}

// NewVersionAPI creates a VersionAPI reporting protocolVersion, the rendezvous
// protocol the binary speaks (server.RendezvousProtocolVersion).
func NewVersionAPI(protocolVersion int) *VersionAPI {
	return &VersionAPI{protocolVersion: protocolVersion}
}

// HandleVersion returns the server version and the rendezvous protocol version
// (a remote bootstrap page compares the latter against its own constant and
// refuses to boot on a mismatch).
func (api *VersionAPI) HandleVersion(w http.ResponseWriter, r *http.Request) {
	WriteJSON(w, r, 0, map[string]any{
		"version":         core.Version,
		"protocolVersion": api.protocolVersion,
	})
}
