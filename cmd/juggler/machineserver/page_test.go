//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
)

// fetch GETs url and returns status, headers and body.
func fetch(t *testing.T, url string) (int, http.Header, string) {
	t.Helper()
	resp, err := http.Get(url) //nolint:gosec,noctx // test server URL
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, resp.Header, string(body)
}

var (
	pageConfigPattern = regexp.MustCompile(`(?s)<script type="application/json" id="machine-config">(.*?)</script>`)
	pageRefPattern    = regexp.MustCompile(`(?:src|href)="(/[^"]*)"`)
	pageNoncePattern  = regexp.MustCompile(`<script nonce="([^"]+)">`)
)

// decodePageConfig decodes the configuration the sessions page carries for its
// script.
func decodePageConfig(t *testing.T, body string) map[string]any {
	t.Helper()
	m := pageConfigPattern.FindStringSubmatch(body)
	if m == nil {
		t.Fatalf("sessions page carries no machine-config:\n%s", body)
	}
	var cfg map[string]any
	if err := json.Unmarshal([]byte(m[1]), &cfg); err != nil {
		t.Fatalf("machine-config %q: %v", m[1], err)
	}
	return cfg
}

// TestSessionsPageCarriesTheControlToken: GET / is the sessions page, and it
// hands its script the control-API token — the page is behind the Host guard
// and the LAN gate like everything else here, so whoever may load it may hold
// the token. The page is never cached, since it carries a secret that changes
// with every server process, and it runs under a CSP that admits only this
// origin and the page's own nonce'd inline script.
func TestSessionsPageCarriesTheControlToken(t *testing.T) {
	s := &Server{reg: newRegistry(), token: testToken, uiLocale: func() string { return "" }}
	front := httptest.NewServer(s.routes())
	defer front.Close()

	code, hdr, body := fetch(t, front.URL+"/")
	if code != http.StatusOK || !strings.HasPrefix(hdr.Get("Content-Type"), "text/html") {
		t.Fatalf("GET /: status %d, type %q", code, hdr.Get("Content-Type"))
	}
	if got := decodePageConfig(t, body)["token"]; got != testToken {
		t.Fatalf("page token = %v, want the server's", got)
	}
	if cc := hdr.Get("Cache-Control"); !strings.Contains(cc, "no-store") {
		t.Errorf("Cache-Control = %q, want no-store", cc)
	}
	csp := hdr.Get("Content-Security-Policy")
	nonce := pageNoncePattern.FindStringSubmatch(body)
	if nonce == nil {
		t.Fatalf("page has no nonce'd inline script")
	}
	for _, want := range []string{"default-src 'self'", "script-src 'self' 'nonce-" + nonce[1] + "'", "frame-ancestors 'none'", "object-src 'none'"} {
		if !strings.Contains(csp, want) {
			t.Errorf("CSP %q lacks %q", csp, want)
		}
	}
	if strings.Contains(csp, "unsafe-inline") || strings.Contains(csp, "unsafe-eval") {
		t.Errorf("CSP %q admits inline or eval'd script or style", csp)
	}

	// A second load gets a fresh nonce.
	_, _, again := fetch(t, front.URL+"/")
	if n2 := pageNoncePattern.FindStringSubmatch(again); n2 == nil || n2[1] == nonce[1] {
		t.Errorf("two loads of the page share the nonce %q", nonce[1])
	}
}

// TestSessionsPageAssetsResolve: everything the page loads is served from this
// server, with a JavaScript type for modules and a long-lived cache for the
// versioned paths (the version changes with the process).
func TestSessionsPageAssetsResolve(t *testing.T) {
	s := &Server{reg: newRegistry(), token: testToken, uiLocale: func() string { return "" }}
	front := httptest.NewServer(s.routes())
	defer front.Close()

	_, _, body := fetch(t, front.URL+"/")
	refs := pageRefPattern.FindAllStringSubmatch(body, -1)
	if len(refs) < 4 {
		t.Fatalf("page references %d assets, want its stylesheets, icon and script", len(refs))
	}
	sawModule := false
	for _, m := range refs {
		u := m[1]
		if !strings.HasPrefix(u, "/v"+assetVersion+"/") {
			t.Errorf("page references %q outside this process's versioned asset root", u)
			continue
		}
		code, hdr, _ := fetch(t, front.URL+u)
		if code != http.StatusOK {
			t.Errorf("GET %s: status %d", u, code)
			continue
		}
		if !strings.Contains(hdr.Get("Cache-Control"), "immutable") {
			t.Errorf("GET %s: Cache-Control %q, want immutable", u, hdr.Get("Cache-Control"))
		}
		if strings.HasSuffix(u, ".js") {
			sawModule = true
			if ct := hdr.Get("Content-Type"); !strings.HasPrefix(ct, "text/javascript") {
				t.Errorf("GET %s: Content-Type %q, want text/javascript", u, ct)
			}
		}
	}
	if !sawModule {
		t.Errorf("page loads no script")
	}
}

// TestMachineServerServesOnlyItsAssetRoots: the versioned root serves the
// directories a page draws on, and nothing else of the tree — not the app's
// own page templates — and nothing under another version.
func TestMachineServerServesOnlyItsAssetRoots(t *testing.T) {
	s := &Server{reg: newRegistry(), token: testToken}
	front := httptest.NewServer(s.routes())
	defer front.Close()
	v := "/v" + assetVersion
	for _, p := range []string{v + "/css/tokens/scale.css", v + "/machine/sessions-page.js", v + "/sdk/lib/i18n.js", v + "/js/utils/icons.js", v + "/resources/juggler-logo.svg"} {
		if code, _, _ := fetch(t, front.URL+p); code != http.StatusOK {
			t.Errorf("GET %s: status %d, want 200", p, code)
		}
	}
	for _, p := range []string{v + "/index.html", v + "/engine.html", v + "/machine/index.html", v + "/", "/vstale/css/tokens/scale.css", "/css/tokens/scale.css"} {
		if code, _, _ := fetch(t, front.URL+p); code != http.StatusNotFound {
			t.Errorf("GET %s: status %d, want 404", p, code)
		}
	}
}

// TestSessionsPageSpeaksTheChosenLanguage: the page is written in the UI
// language the user chose, with its catalogue inline, as a session's page is.
func TestSessionsPageSpeaksTheChosenLanguage(t *testing.T) {
	s := &Server{reg: newRegistry(), token: testToken, uiLocale: func() string { return "en-XA" }}
	front := httptest.NewServer(s.routes())
	defer front.Close()
	_, _, body := fetch(t, front.URL+"/")
	if !strings.Contains(body, `<html lang="en-XA" data-ui-locale="en-XA"`) {
		t.Errorf("page does not declare en-XA:\n%.300s", body)
	}
	if !strings.Contains(body, `<script type="application/json" id="juggler-ui-catalog">{`) {
		t.Errorf("page carries no catalogue for en-XA")
	}

	s.uiLocale = func() string { return "" }
	_, _, plain := fetch(t, front.URL+"/")
	if !strings.Contains(plain, `<html lang="en">`) || strings.Contains(plain, "juggler-ui-catalog") {
		t.Errorf("with no language chosen the page should be plain English, with no catalogue")
	}
}
