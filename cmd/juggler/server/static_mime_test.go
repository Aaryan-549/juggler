//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"io/fs"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/mux"

	"juggler/cmd/juggler/server/handlers"
	"juggler/web"
)

// TestStaticModuleMIME guards against a host MIME database (notably the Windows
// registry, where .mjs is often mapped to text/plain) making the static file
// server label ES modules with a non-JavaScript type. A module served as
// text/plain is rejected by the browser's strict MIME check, which silently
// breaks the app's entire module graph (app.js imports Yjs) while leaving
// standalone modules working — the exact "no buttons work except the logo"
// failure. The wrapper forces the type regardless of the OS mime DB, so this
// passes on every platform.
func TestStaticModuleMIME(t *testing.T) {
	builtinFS, err := fs.Sub(web.Files, ".")
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{
		router:        mux.NewRouter(),
		staticVersion: "test",
		serverAPIs:    serverAPIs{extensionsAPI: handlers.NewExtensionsAPI(builtinFS, "", "")},
	}
	s.setupRoutes()

	// yjs.mjs is a real embedded vendor module and the one from the field report.
	rec := httptest.NewRecorder()
	s.router.ServeHTTP(rec, httptest.NewRequest("GET", "/vtest/js/vendor/yjs.mjs", nil))
	if rec.Code != 200 {
		t.Fatalf("yjs.mjs not served: %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/javascript") {
		t.Fatalf("yjs.mjs served as %q; a module must have a JavaScript media type", ct)
	}
}
