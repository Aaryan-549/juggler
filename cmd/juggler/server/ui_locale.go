//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"encoding/json"
	"net/http"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/extmanifest"
	"juggler/cmd/juggler/server/handlers"
	"juggler/internal/jlog"
	"juggler/web"
)

// The UI language. The choice is GlobalSettings.UILocale; the translations are
// web/i18n/<locale>.json, one flat object per locale mapping each English
// source string to its translation (the format registerCatalog takes — see
// web/sdk/lib/i18n.js). web/i18n/en.json is the list of source strings that
// translators work from, never a catalogue: English is what every message
// already is.
//
// A viewer is handed its catalogue inline by serveIndex, so the first frame is
// already translated. The engine has no page of its own to read, so it fetches
// the same file through handleUICatalog.

// uiCatalogDir is where the catalogues live in the web asset tree.
const uiCatalogDir = "i18n"

// uiSourceLocale is the language messages are written in, and so the page's
// language when none is chosen.
const uiSourceLocale = "en"

// loadUICatalog returns the catalogue for locale: the catalogues along the
// language's chain — "zh-Hant-TW", "zh-Hant", "zh", stopping at the source
// language (extmanifest.LocaleChain) — merged, each message from the most
// specific file that has it (extmanifest.MergeChain, as extension catalogues
// are). Nil when the locale is invalid or nothing matches; a catalogue that
// will not parse is logged and treated as missing, so a bad file costs its
// translations rather than the page.
func loadUICatalog(read func(string) ([]byte, error), locale string) map[string]string {
	if !core.IsValidUILocale(locale) {
		return nil
	}
	chain := extmanifest.LocaleChain(locale)
	found := map[string]map[string]string{}
	for _, candidate := range chain {
		data, err := read(uiCatalogDir + "/" + candidate + ".json")
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

// uiLocale is the UI language the user chose, or "" for the default. A server
// without a settings store (a bare test server) has none.
func (s *Server) uiLocale() string {
	if s.settings == nil {
		return ""
	}
	return core.NormalizeUILocale(s.settings.get().UILocale)
}

// uiCatalog is the catalogue for locale from the served asset tree (the disk
// tree under --assets-from-disk, so an edited catalogue shows on reload).
func (s *Server) uiCatalog(locale string) map[string]string {
	return loadUICatalog(func(p string) ([]byte, error) { return s.readWebAsset(p, web.Files) }, locale)
}

// uiCatalogResponse is GET /api/i18n/catalog's body.
type uiCatalogResponse struct {
	Locale   string            `json:"locale"`
	Messages map[string]string `json:"messages"`
	// Extensions holds each extension's own catalogue for the locale, by
	// extension id (see ExtensionsAPI.Catalogs); registered by the client under
	// that id as its namespace.
	Extensions map[string]map[string]string `json:"extensions"`
}

// handleUICatalog serves GET /api/i18n/catalog?locale=<tag>: the core
// catalogue — what the page would have been given inline — and every
// extension's. The engine reads both from here; a viewer reads the extensions'
// before loading their code (the core one is already in its page). A locale with
// no catalogue answers an empty one — every message then falls back to English,
// which is the same thing a missing catalogue means anywhere else.
func (s *Server) handleUICatalog(w http.ResponseWriter, r *http.Request) {
	locale := r.URL.Query().Get("locale")
	if !core.IsValidUILocale(locale) {
		handlers.WriteError(w, r, http.StatusBadRequest, "invalid UI language")
		return
	}
	messages := s.uiCatalog(locale)
	if messages == nil {
		messages = map[string]string{}
	}
	extensions := map[string]map[string]string{}
	if s.extensionsAPI != nil {
		extensions = s.extensionsAPI.Catalogs(locale)
	}
	handlers.WriteJSON(w, r, 0, uiCatalogResponse{Locale: locale, Messages: messages, Extensions: extensions})
}
