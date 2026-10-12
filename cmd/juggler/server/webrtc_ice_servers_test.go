//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/internal/srcroot"

	"github.com/gorilla/mux"
	"github.com/pion/webrtc/v4"
)

var pageICEServersPattern = regexp.MustCompile(`window\.__jugglerIceServers = (.*);`)

// TestViewerPageCarriesTheServersICEServers checks the two ends of a direct
// WebRTC link take their ICE servers from one place: the served viewer page
// hands its scripts exactly defaultICEServers, and the viewer's offer reads
// them from the page rather than naming a server of its own.
func TestViewerPageCarriesTheServersICEServers(t *testing.T) {
	mgr, err := core.NewSessionManagerForPath(t.TempDir())
	if err != nil {
		t.Fatalf("NewSessionManagerForPath: %v", err)
	}
	t.Cleanup(mgr.Shutdown)
	s := &Server{router: mux.NewRouter(), apiToken: testAPIToken, staticVersion: "test-static-version"}
	s.projectState.Store(&projectState{sessionManager: mgr, projectPath: t.TempDir()})
	if err := s.loadIndexTemplate(); err != nil {
		t.Fatalf("loadIndexTemplate: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = localViewerAddr
	rec := httptest.NewRecorder()
	s.serveIndex(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("serveIndex: status %d", rec.Code)
	}
	m := pageICEServersPattern.FindStringSubmatch(rec.Body.String())
	if m == nil {
		t.Fatalf("index page sets no window.__jugglerIceServers")
	}
	var got []webrtc.ICEServer
	if err := json.Unmarshal([]byte(m[1]), &got); err != nil {
		t.Fatalf("window.__jugglerIceServers is not JSON (%v): %s", err, m[1])
	}
	if !reflect.DeepEqual(got, defaultICEServers) {
		t.Fatalf("page ICE servers %+v, want the server's %+v", got, defaultICEServers)
	}

	root, err := srcroot.Find("")
	if err != nil {
		t.Fatalf("srcroot.Find: %v", err)
	}
	src, err := os.ReadFile(filepath.Join(root, "web", "js", "services", "websocket.js"))
	if err != nil {
		t.Fatalf("read websocket.js: %v", err)
	}
	if regexp.MustCompile("['\"`](stuns?|turns?):").Match(src) {
		t.Errorf("websocket.js names an ICE server of its own; it must use window.__jugglerIceServers")
	}
	if !regexp.MustCompile(`iceServers:[^\n]*__jugglerIceServers`).Match(src) {
		t.Errorf("websocket.js's peer connection does not take its iceServers from __jugglerIceServers")
	}
}
