//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"juggler/internal/apipaths"
)

// TestMachineServerAdmitsAllowedHostAsRemote stands in for a reverse proxy on
// this machine (tailscale serve) in front of a real `serve --allow-host`. It
// connects over loopback and forwards its public name as Host. A session's page
// and API work under that name while LAN access is off. The real child behind
// the proxy treats the caller as remote: it cannot write this machine's UI
// preferences or take the engine slot. A name not on the list is still
// refused.
func TestMachineServerAdmitsAllowedHostAsRemote(t *testing.T) {
	const allowed = "box.tailnet.example.ts.net"
	ms, stop := startMachineServer(t, "--allow-host", allowed)
	defer stop()
	sess := ms.openSession(newProjectDir(t), http.StatusCreated)
	prefix := "/s/" + sess.ID

	do := func(method, path, host, token, body string) (int, string) {
		t.Helper()
		req, err := http.NewRequest(method, ms.url(path), strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Host = host
		req.Header.Set("Origin", "https://"+host)
		if token != "" {
			req.Header.Set("X-Juggler-Token", token)
			req.Header.Set("Content-Type", "application/json")
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", method, path, err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(b)
	}

	code, page := do(http.MethodGet, prefix+"/", allowed, "", "")
	m := apiTokenPattern.FindStringSubmatch(page)
	if code != http.StatusOK || m == nil {
		t.Fatalf("GET %s/ with Host %s: status %d, token found %v; want 200 with a token", prefix, allowed, code, m != nil)
	}
	token := m[1]

	if code, body := do(http.MethodPut, prefix+"/api/session/ui-zoom", allowed, token, `{"uiZoom":110}`); code != http.StatusForbidden {
		t.Errorf("PUT ui-zoom through the proxy: status %d (%s), want 403 (a remote viewer)", code, strings.TrimSpace(body))
	}
	addr := strings.TrimPrefix(ms.url(""), "http://")
	if code, body := do(http.MethodPut, prefix+"/api/session/ui-zoom", addr, token, `{"uiZoom":110}`); code != http.StatusOK {
		t.Errorf("PUT ui-zoom from this machine: status %d (%s), want 200", code, strings.TrimSpace(body))
	}
	if code, _ := do(http.MethodGet, prefix+"/", "other.tailnet.example.ts.net", "", ""); code != http.StatusForbidden {
		t.Errorf("GET %s/ with an unlisted Host: status %d, want 403", prefix, code)
	}

	// The engine slot: refused by closing the socket before any frame, where
	// an admitted engine is greeted with the session frame first.
	dialer := websocket.Dialer{
		NetDial: func(network, _ string) (net.Conn, error) { return net.Dial(network, addr) },
	}
	header := http.Header{"Origin": []string{"https://" + allowed}}
	conn, resp, err := dialer.Dial("ws://"+allowed+prefix+apipaths.WebSocket+"?role=engine", header)
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		t.Fatalf("engine WebSocket dial through the proxy: %v", err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	if _, msg, err := conn.ReadMessage(); err == nil {
		t.Fatalf("a caller through the proxy took the engine slot; first frame %s", msg)
	}
}
