//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// Whose engine is this? The engine slot goes to the newest arrival, and an
// engine dials its server's address forever — so an engine that outlives its
// server finds whatever binds that address next and is adopted by it. The
// stranger then receives the work meant for the real engine and does nothing
// with it, which is a run that hangs until its caller gives up rather than an
// error anyone can see.
//
// The per-process API token is the only thing that tells the two apart, and
// both engine realms carry it: the webview worker is handed it in its start
// message, the node host in JUGGLER_TOKEN. These pin that the engine role is
// admitted with our token and with nothing else — not another instance's, and
// not none — and that the refusal comes before the upgrade, so a refused caller
// never holds a socket at all.

// testSocketToken is the API token the socket servers in these tests are given.
const testSocketToken = "this-instance"

// dialEngineToken opens an engine-role WebSocket carrying the given token
// (omitted entirely when empty), and reports whether the server kept it. A
// refusal is an HTTP 403 in place of the upgrade; anything else failing the
// dial fails the test.
func dialEngineToken(t *testing.T, ts *httptest.Server, token string) bool {
	t.Helper()
	target := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws?role=engine"
	if token != "" {
		target += "&token=" + url.QueryEscape(token)
	}
	conn, resp, err := websocket.DefaultDialer.Dial(target, nil)
	if resp != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		if resp != nil && resp.StatusCode == http.StatusForbidden {
			return false
		}
		t.Fatalf("engine WS dial failed: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })

	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, _, readErr := conn.ReadMessage()
	if readErr != nil {
		t.Fatalf("the engine was upgraded and then dropped (%v); a refusal belongs before the upgrade", readErr)
	}
	return true
}

func TestEngineUpgradeRefusesAnythingButOurToken(t *testing.T) {
	for _, tc := range []struct {
		name  string
		token string
	}{
		{"another instance's token", "the-instance-that-died"},
		{"no token at all", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, ts := newEngineSocketServer(t)

			if dialEngineToken(t, ts, tc.token) {
				t.Fatal("the engine was let in")
			}
			if s.IsEngineConnected() {
				t.Fatal("a refused engine still took the engine slot")
			}
		})
	}
}

func TestEngineUpgradeAcceptsOurOwnToken(t *testing.T) {
	s, ts := newEngineSocketServer(t)

	if !dialEngineToken(t, ts, testSocketToken) {
		t.Fatal("the engine was refused")
	}
	if !s.IsEngineConnected() {
		t.Fatal("the engine connected but never took the engine slot")
	}
}
