//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package webui holds what every server that serves pages from the web asset
// tree (package web) needs alike: stable content types for its assets and the
// UI-language catalogues. A project's server and the machine server both use
// it.
package webui

import (
	"encoding/json"
	"net/http"
	"path"
	"strings"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/extmanifest"
	"juggler/internal/jlog"
)

// ContentType returns a stable Content-Type for the web-asset extensions the
// app serves, or "" to defer to the file server's own detection.
//
// http.FileServer derives the type from mime.TypeByExtension, which consults the
// host MIME database — and on Windows that comes from the registry, where .mjs is
// frequently mapped to text/plain (and other web types are unreliable too). A
// module script served as text/plain is rejected by the browser's strict MIME
// check, which silently breaks the app's entire ES-module graph (e.g.
// web/js/vendor/yjs.mjs) while leaving unrelated standalone modules loading — so
// these types are set explicitly rather than trusted to the OS.
func ContentType(p string) string {
	switch strings.ToLower(path.Ext(p)) {
	case ".js", ".mjs", ".cjs":
		return "text/javascript; charset=utf-8"
	case ".json", ".map":
		return "application/json; charset=utf-8"
	case ".css":
		return "text/css; charset=utf-8"
	case ".svg":
		return "image/svg+xml"
	case ".wasm":
		return "application/wasm"
	default:
		return ""
	}
}

// AssetHandler wraps a static file server, forcing a stable Content-Type for
// known web-asset extensions so serving is correct regardless of the host MIME
// database (see ContentType). http.ServeContent (used by http.FileServer) only
// sniffs a type when Content-Type is unset, so a header set here is preserved.
func AssetHandler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if ct := ContentType(r.URL.Path); ct != "" {
			w.Header().Set("Content-Type", ct)
		}
		next.ServeHTTP(w, r)
	})
}

// CatalogDir is where the UI-language catalogues live in the web asset tree.
const CatalogDir = "i18n"

// SourceLocale is the language messages are written in, and so a page's
// language when none is chosen.
const SourceLocale = "en"

// LoadCatalog returns the UI catalogue for locale, read from the asset tree
// through read: the catalogues along the language's chain — "zh-Hant-TW",
// "zh-Hant", "zh", stopping at the source language (extmanifest.LocaleChain) —
// merged, each message from the most specific file that has it
// (extmanifest.MergeChain, as extension catalogues are). Nil when the locale is
// invalid or nothing matches; a catalogue that will not parse is logged and
// treated as missing, so a bad file costs its translations rather than the
// page.
func LoadCatalog(read func(string) ([]byte, error), locale string) map[string]string {
	if !core.IsValidUILocale(locale) {
		return nil
	}
	chain := extmanifest.LocaleChain(locale)
	found := map[string]map[string]string{}
	for _, candidate := range chain {
		data, err := read(CatalogDir + "/" + candidate + ".json")
		if err != nil {
			continue
		}
		var messages map[string]string
		if err := json.Unmarshal(data, &messages); err != nil {
			jlog.Error("[i18n] %s.json is not a valid catalogue: %v", candidate, err)
			continue
		}
		found[candidate] = messages
	}
	return extmanifest.MergeChain(found, chain)
}
