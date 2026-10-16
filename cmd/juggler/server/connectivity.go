//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"fmt"
	"net"
	"net/http"
	"strconv"

	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/server/handlers"
)

// setupConnectivityRoutes registers the /api/connectivity endpoints.
func (s *Server) setupConnectivityRoutes() {
	api := s.router.PathPrefix("/api").Subrouter()
	api.HandleFunc("/connectivity", s.handleGetConnectivity).Methods("GET")
	api.HandleFunc("/connectivity/lan", s.handleSetLAN).Methods("POST")
	api.HandleFunc("/connectivity/tunnel", s.handleSetTunnel).Methods("POST")
	api.HandleFunc("/connectivity/qr", handlers.HandleQRCode).Methods("GET")
}

func (s *Server) handleGetConnectivity(w http.ResponseWriter, r *http.Request) {
	port := s.getPort()
	lanURLs := []string{}
	if s.publicMode.Load() {
		for _, a := range getLANAddresses() {
			lanURLs = append(lanURLs, fmt.Sprintf("http://%s/", net.JoinHostPort(a.ip, strconv.Itoa(port))))
		}
	}
	tunnelMode := ""
	tunnelRelay := false
	if info, ok := s.GetTunnelInfo(); ok {
		tunnelMode = string(info.Mode)
		tunnelRelay = info.Relay
	}
	// One descriptor per connected viewer (this client included). The UI excludes
	// itself by id to show how many OTHER clients share the session.
	clients := s.hub.viewerClients()
	// The persistent WebRTC identity fingerprint (stable across restarts), or ""
	// when the server is using ephemeral per-connection certificates. Exposed so
	// the UI can show a stable device identity and a remote client can pin it.
	peerIdentity, _ := s.PeerIdentityFingerprint()
	handlers.WriteJSON(w, r, 0, map[string]any{
		"lanEnabled":    s.publicMode.Load(),
		"lanURLs":       lanURLs,
		"tunnelEnabled": s.IsTunnelActive(),
		"tunnelURL":     s.GetTunnelURL(),
		"tunnelMode":    tunnelMode,
		"tunnelRelay":   tunnelRelay,
		"wanModes":      wanModesPayload(),
		"clientCount":   len(clients),
		"clients":       clients,
		"peerIdentity":  peerIdentity,
	})
}

// wanModesPayload is the wanModes list GET /api/connectivity reports. The WAN
// section of the UI is driven entirely by it: a build with no registered
// tunnel modes reports an empty list and shows no WAN UI. Each presentation
// field is sent as its English under the plain key and, when the spec sets it,
// as the message under the key plus "Message" (titleMessage, …), which the page
// renders with serverText.
func wanModesPayload() []map[string]any {
	wanModes := []map[string]any{}
	for _, spec := range TunnelModes() {
		mode := map[string]any{
			"mode":      string(spec.Mode),
			"available": spec.IsAvailable(),
		}
		for _, field := range []struct {
			name    string
			message msg.Message
		}{
			{"title", spec.Title},
			{"description", spec.Description},
			{"startLabel", spec.StartLabel},
			{"relayNote", spec.RelayNote},
			{"unavailableHint", spec.UnavailableHint},
		} {
			mode[field.name] = field.message.English()
			if !field.message.IsZero() {
				mode[field.name+"Message"] = field.message
			}
		}
		wanModes = append(wanModes, mode)
	}
	return wanModes
}

func (s *Server) handleSetLAN(w http.ResponseWriter, r *http.Request) {
	req, ok := handlers.DecodeJSON[struct {
		Enabled bool `json:"enabled"`
	}](w, r)
	if !ok {
		return
	}
	s.SetPublicMode(req.Enabled)
	handlers.WriteSuccess(w, r, nil)
}

func (s *Server) handleSetTunnel(w http.ResponseWriter, r *http.Request) {
	req, ok := handlers.DecodeJSON[struct {
		Enabled bool   `json:"enabled"`
		Mode    string `json:"mode"`
	}](w, r)
	if !ok {
		return
	}
	if !req.Enabled {
		s.StopTunnel()
		handlers.WriteSuccess(w, r, nil)
		return
	}
	// Validate against the registry: an empty mode selects the first
	// registered one (there is no WAN feature at all when none are).
	mode := TunnelMode(req.Mode)
	if mode == "" {
		modes := TunnelModes()
		if len(modes) == 0 {
			handlers.WriteMessageError(w, r, http.StatusBadRequest, msg.New("no WAN tunnel modes are available in this build"))
			return
		}
		mode = modes[0].Mode
	} else if _, ok := findTunnelMode(mode); !ok {
		handlers.WriteMessageError(w, r, http.StatusBadRequest, msg.New("unknown tunnel mode {mode}", "mode", strconv.Quote(req.Mode)))
		return
	}
	tunnelURL, err := s.StartTunnelMode(mode)
	if err != nil {
		handlers.WriteErr(w, r, http.StatusBadRequest, err)
		return
	}
	relay := false
	if info, ok := s.GetTunnelInfo(); ok {
		relay = info.Relay
	}
	handlers.WriteSuccess(w, r, map[string]any{"tunnelURL": tunnelURL, "tunnelMode": string(mode), "relay": relay})
}
