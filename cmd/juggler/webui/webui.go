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
	"io/fs"
	"net/http"
	"path"
	"slices"
	"strings"
	"sync/atomic"

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

// PseudoLocale is the generated pseudo-locale (web/i18n/en-XA.json): a test
// of the translation machinery, not a language to offer.
const PseudoLocale = "en-XA"

// AvailableLocales lists the UI languages there is a catalogue for: each
// <tag>.json in CatalogDir across trees — the embedded asset tree and, when
// assets are served from disk, the on-disk one — except the source list
// (SourceLocale) and PseudoLocale, canonical (core.NormalizeUILocale), deduped
// and sorted. A file whose name is not a UI language tag is skipped. Never nil.
//
// Registered sources (RegisterCatalogFS) add none: they carry messages for Go
// code outside this module, and a language is available only when the core UI
// is translated into it.
func AvailableLocales(trees ...fs.FS) []string {
	out := []string{}
	for _, tree := range trees {
		entries, err := fs.ReadDir(tree, CatalogDir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			name, ok := strings.CutSuffix(entry.Name(), ".json")
			if !ok || entry.IsDir() || !core.IsValidUILocale(name) {
				continue
			}
			tag := core.NormalizeUILocale(name)
			if tag == SourceLocale || tag == PseudoLocale || slices.Contains(out, tag) {
				continue
			}
			out = append(out, tag)
		}
	}
	slices.Sort(out)
	return out
}

// catalogSource is a directory of <locale>.json catalogues registered with
// RegisterCatalogFS.
type catalogSource struct {
	fsys fs.FS
	dir  string
}

// catalogSources is the registered sources, replaced whole on every change so
// LoadCatalog reads a stable list without a lock.
var catalogSources atomic.Pointer[[]*catalogSource]

// updateCatalogSources replaces the source list with edit's copy of it.
func updateCatalogSources(edit func([]*catalogSource) []*catalogSource) {
	for {
		old := catalogSources.Load()
		var current []*catalogSource
		if old != nil {
			current = *old
		}
		next := edit(slices.Clone(current))
		if catalogSources.CompareAndSwap(old, &next) {
			return
		}
	}
}

// RegisterCatalogFS adds a source of UI messages to the core catalogue: dir on
// fsys holds <locale>.json files in the core catalogue's format (web/i18n),
// for Go code compiled into the server that is not in this module's source —
// `scripts/i18n extract --go-root <dir> --catalog <dir>` generates them.
// LoadCatalog merges each source's messages for a locale, along the same
// chain, into what it returns, so the page's inline catalogue and GET
// /api/i18n/catalog both carry them.
//
// A source adds messages and never replaces one: on a key the core catalogue
// translates, the core's translation stands, and among sources the one
// registered first wins. Call it before the server starts; the returned func
// removes the source again (for tests).
func RegisterCatalogFS(fsys fs.FS, dir string) (unregister func()) {
	src := &catalogSource{fsys: fsys, dir: dir}
	updateCatalogSources(func(list []*catalogSource) []*catalogSource { return append(list, src) })
	return func() {
		updateCatalogSources(func(list []*catalogSource) []*catalogSource {
			return slices.DeleteFunc(list, func(s *catalogSource) bool { return s == src })
		})
	}
}

// LoadCatalog returns the UI catalogue for locale, read from the asset tree
// through read: the catalogues along the language's chain — "zh-Hant-TW",
// "zh-Hant", "zh", stopping at the source language (extmanifest.LocaleChain) —
// merged, each message from the most specific file that has it
// (extmanifest.MergeChain, as extension catalogues are), then each registered
// source's messages for the same chain that the result lacks
// (RegisterCatalogFS). Nil when the locale is invalid or nothing matches; a
// catalogue that will not parse is logged and treated as missing, so a bad
// file costs its translations rather than the page.
func LoadCatalog(read func(string) ([]byte, error), locale string) map[string]string {
	if !core.IsValidUILocale(locale) {
		return nil
	}
	chain := extmanifest.LocaleChain(locale)
	out := loadChain(read, CatalogDir, chain)
	var sources []*catalogSource
	if list := catalogSources.Load(); list != nil {
		sources = *list
	}
	for _, src := range sources {
		read := func(p string) ([]byte, error) { return fs.ReadFile(src.fsys, p) }
		for key, message := range loadChain(read, src.dir, chain) {
			if _, taken := out[key]; taken {
				continue
			}
			if out == nil {
				out = map[string]string{}
			}
			out[key] = message
		}
	}
	return out
}

// loadChain reads and merges the catalogues along chain from dir.
func loadChain(read func(string) ([]byte, error), dir string, chain []string) map[string]string {
	found := map[string]map[string]string{}
	for _, candidate := range chain {
		data, err := read(path.Join(dir, candidate+".json"))
		if err != nil {
			continue
		}
		var messages map[string]string
		if err := json.Unmarshal(data, &messages); err != nil {
			jlog.Error("[i18n] %s/%s.json is not a valid catalogue: %v", dir, candidate, err)
			continue
		}
		found[candidate] = messages
	}
	return extmanifest.MergeChain(found, chain)
}
