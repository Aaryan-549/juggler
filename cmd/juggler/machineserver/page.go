//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"crypto/rand"
	"encoding/hex"
	"html/template"
	"io/fs"
	"net/http"
	"os"
	"slices"
	"strings"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/webui"
	"juggler/internal/jlog"
	"juggler/web"
)

// The sessions page: GET / on the machine server. It lists the sessions this
// server runs and opens, stops and launches them through the control API. It is
// its own small page (web/machine/), drawing only the app's fonts, theme tokens
// and element defaults from the asset tree, not the session client.

// assetVersion names this process's versioned asset root, /v<assetVersion>/.
// It is fresh per process, so the root can be cached for good.
var assetVersion = mintAssetVersion()

func mintAssetVersion() string {
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		panic("machineserver.mintAssetVersion: crypto/rand failed: " + err.Error())
	}
	return hex.EncodeToString(b)
}

// assetRoots are the directories of the web tree served under the versioned
// root: what the sessions page draws on, and nothing of the app's own pages.
var assetRoots = []string{"css", "js", "machine", "resources", "sdk"}

// pageTemplate is the sessions page's template in the web tree.
const pageTemplate = "machine/index.html"

// assetHandler serves files of the web tree under /v<assetVersion>/, from
// assetRoots only. Directories and HTML (page templates) are not served.
func assetHandler() http.Handler {
	files := webui.AssetHandler(http.FileServer(http.FS(web.Files)))
	prefix := "/v" + assetVersion + "/"
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rel := strings.TrimPrefix(r.URL.Path, prefix)
		top, rest, _ := strings.Cut(rel, "/")
		if rest == "" || !slices.Contains(assetRoots, top) || strings.HasSuffix(rel, ".html") {
			http.NotFound(w, r)
			return
		}
		if info, err := fs.Stat(web.Files, rel); err != nil || info.IsDir() {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		r2 := r.Clone(r.Context())
		r2.URL.Path = "/" + rel
		r2.URL.RawPath = ""
		files.ServeHTTP(w, r2)
	})
}

// pageConfig is what the page hands its script, as JSON in the
// #machine-config element (web/machine/control-api.js, readPageConfig).
type pageConfig struct {
	// Token is the control-API credential. Delivering it in the page is safe
	// behind hostGuard and the LAN gate: whoever may load the page may drive
	// the control API anyway. readPageConfig is the one place the page's
	// script takes its credential from, so another delivery replaces both
	// ends of this field and nothing else.
	Token   string `json:"token"`
	Version string `json:"version"`
	Host    string `json:"host"`
}

// handlePage serves the sessions page. GET /.
func (s *Server) handlePage(w http.ResponseWriter, _ *http.Request) {
	tmpl, err := template.ParseFS(web.Files, pageTemplate)
	if err != nil {
		jlog.Error("[machineserver] sessions page template: %v", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	locale := ""
	if s.uiLocale != nil {
		locale = s.uiLocale()
	}
	lang := webui.SourceLocale
	var catalog map[string]string
	if locale != "" {
		lang = locale
		catalog = webui.LoadCatalog(func(p string) ([]byte, error) { return fs.ReadFile(web.Files, p) }, locale)
	}
	host, _ := os.Hostname()

	nonce := mintNonce()
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	// The page carries a secret that changes with every server process.
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'nonce-"+nonce+"'; "+
		"style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; "+
		"object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")

	data := struct {
		AssetBase string
		CSPNonce  string
		HTMLLang  string
		UILocale  string
		UICatalog map[string]string
		Config    pageConfig
	}{
		AssetBase: "/v" + assetVersion,
		CSPNonce:  nonce,
		HTMLLang:  lang,
		UILocale:  locale,
		UICatalog: catalog,
		Config:    pageConfig{Token: s.token, Version: core.Version, Host: host},
	}
	if err := tmpl.Execute(w, data); err != nil {
		jlog.Error("[machineserver] sessions page: %v", err)
	}
}

// mintNonce returns a fresh CSP nonce for one page load. Hex, so the template
// writes it into the page byte for byte (base64's + would be escaped).
func mintNonce() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic("machineserver.mintNonce: crypto/rand failed: " + err.Error())
	}
	return hex.EncodeToString(b)
}

// settingsUILocale is the UI language the user chose in settings, or "" for
// none. Read on every page load, so a language chosen in a session shows on
// the sessions page at its next load.
func settingsUILocale() string {
	gs, err := core.LoadGlobalSettings()
	if err != nil {
		jlog.Error("[machineserver] reading settings for the UI language: %v", err)
	}
	return core.NormalizeUILocale(gs.UILocale)
}
