//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gorilla/mux"

	"juggler/internal/hostcheck"
	"juggler/internal/ingress"
)

// proxyIngressHarness is a Server with the front of the real middleware chain
// (proxy ingress, LAN gate, page Host gate) and an allowed host, whose handler
// records how the request it reached was classified.
type proxyIngressHarness struct {
	s       *Server
	reached bool
	kind    string
	engine  bool
	local   bool
}

func newProxyIngressHarness(t *testing.T, public bool) *proxyIngressHarness {
	t.Helper()
	allowed, err := hostcheck.NewAllowList([]string{"box.tailnet.ts.net"})
	if err != nil {
		t.Fatal(err)
	}
	h := &proxyIngressHarness{s: &Server{router: mux.NewRouter(), allowedHosts: allowed}}
	h.s.publicMode.Store(public)
	h.s.router.Use(h.s.proxyIngressMiddleware)
	h.s.router.Use(h.s.lanGateMiddleware)
	h.s.router.Use(h.s.pageHostMiddleware)
	h.s.router.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		h.reached = true
		h.kind = RemoteIngressKind(r)
		h.engine = engineRoleAllowed(r)
		h.local = isLocalDirect(r)
		w.WriteHeader(http.StatusOK)
	})
	return h
}

func (h *proxyIngressHarness) get(remoteAddr, host string) int {
	h.reached, h.kind, h.engine, h.local = false, "", false, false
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = remoteAddr
	req.Host = host
	rec := httptest.NewRecorder()
	h.s.router.ServeHTTP(rec, req)
	return rec.Code
}

// TestProxyIngressTreatsAnAllowedHostOnLoopbackAsRemote is the reason the
// allow-list is more than a Host check. A reverse proxy on this machine
// (tailscale serve) connects over loopback, so by address its callers — anyone
// on the tailnet — would be local: past the LAN gate, able to claim the engine
// slot and write this machine's UI preferences. Naming an allowed host on
// loopback must instead mark the request as remote ingress of kind proxy.
func TestProxyIngressTreatsAnAllowedHostOnLoopbackAsRemote(t *testing.T) {
	h := newProxyIngressHarness(t, false)
	if code := h.get("127.0.0.1:5000", "box.tailnet.ts.net"); code != http.StatusOK || !h.reached {
		t.Fatalf("allowed host via loopback proxy: got %d reached=%v, want 200 reached", code, h.reached)
	}
	if h.kind != ingress.KindProxy || h.engine || h.local {
		t.Fatalf("allowed host via loopback proxy: kind=%q engine=%v local=%v, want kind=proxy, not engine, not local", h.kind, h.engine, h.local)
	}
	// Case and port do not matter.
	if code := h.get("[::1]:5000", "BOX.tailnet.ts.net:443"); code != http.StatusOK || h.kind != ingress.KindProxy {
		t.Fatalf("allowed host with port over ::1: got %d kind=%q, want 200 proxy", code, h.kind)
	}
	// This machine's own names stay local.
	if code := h.get("127.0.0.1:5000", "localhost:3939"); code != http.StatusOK || h.kind != "" || !h.engine || !h.local {
		t.Fatalf("localhost: got %d kind=%q engine=%v local=%v, want 200, untagged, local", code, h.kind, h.engine, h.local)
	}
	// A name not on the list is refused, as before.
	if code := h.get("127.0.0.1:5000", "other.tailnet.ts.net"); code != http.StatusForbidden || h.reached {
		t.Fatalf("unlisted host: got %d reached=%v, want 403 unreached", code, h.reached)
	}
}

// TestProxyIngressLeavesOffLoopbackCallersToTheLANGate: only a loopback
// connection can be the user's own proxy. A caller on the network that sends
// the allowed name as Host (curl -H) must not be carried past the LAN gate by
// it; with LAN access on, the name merely passes the Host check like an IP.
func TestProxyIngressLeavesOffLoopbackCallersToTheLANGate(t *testing.T) {
	h := newProxyIngressHarness(t, false)
	if code := h.get(remoteEdgeAddr, "box.tailnet.ts.net"); code != http.StatusForbidden || h.reached {
		t.Fatalf("off-loopback caller naming the allowed host, LAN off: got %d reached=%v, want 403 unreached", code, h.reached)
	}

	h = newProxyIngressHarness(t, true)
	if code := h.get(remoteEdgeAddr, "box.tailnet.ts.net"); code != http.StatusOK || !h.reached {
		t.Fatalf("off-loopback caller naming the allowed host, LAN on: got %d reached=%v, want 200 reached", code, h.reached)
	}
	if h.kind != "" || h.engine {
		t.Fatalf("LAN caller: kind=%q engine=%v, want untagged and no engine", h.kind, h.engine)
	}
}

// TestProxyIngressKeepsAnEarlierTag: a request a transport already tagged
// (a tunnel, a supervisor) keeps its own kind.
func TestProxyIngressKeepsAnEarlierTag(t *testing.T) {
	allowed, _ := hostcheck.NewAllowList([]string{"box.tailnet.ts.net"})
	s := &Server{allowedHosts: allowed}
	var kind string
	handler := s.proxyIngressMiddleware(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		kind = RemoteIngressKind(r)
	}))
	req := withRemoteIngress(httptest.NewRequest(http.MethodGet, "/", nil))
	req.RemoteAddr = "127.0.0.1:5000"
	req.Host = "box.tailnet.ts.net"
	handler.ServeHTTP(httptest.NewRecorder(), req)
	if kind != "test-transport" {
		t.Fatalf("kind = %q, want the earlier test-transport tag", kind)
	}
}

// TestRemoteTransportLabelNamesTheProxy: the clients list says how a proxied
// viewer arrived rather than printing the raw kind.
func TestRemoteTransportLabelNamesTheProxy(t *testing.T) {
	if got := remoteTransportLabel(ingress.KindProxy); got != "Via reverse proxy" {
		t.Fatalf("remoteTransportLabel(proxy) = %q, want %q", got, "Via reverse proxy")
	}
}
