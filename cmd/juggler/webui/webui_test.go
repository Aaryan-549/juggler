//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package webui

import (
	"io/fs"
	"slices"
	"testing"
	"testing/fstest"
)

func TestContentType(t *testing.T) {
	cases := map[string]string{
		"/js/app.js":          "text/javascript; charset=utf-8",
		"/js/vendor/yjs.mjs":  "text/javascript; charset=utf-8",
		"/sdk/thing.cjs":      "text/javascript; charset=utf-8",
		"/css/styles.css":     "text/css; charset=utf-8",
		"/data/model.json":    "application/json; charset=utf-8",
		"/js/app.js.map":      "application/json; charset=utf-8",
		"/resources/logo.svg": "image/svg+xml",
		"/wasm/mod.wasm":      "application/wasm",
		"/index.html":         "", // defer to the file server's own detection
		"/resources/pic.png":  "",
	}
	for p, want := range cases {
		if got := ContentType(p); got != want {
			t.Errorf("ContentType(%q) = %q, want %q", p, got, want)
		}
	}
}

// A catalogue is looked up along the language's chain, most specific first,
// and never as the English key list: en.json lists the source strings for
// translators, and serving it as a translation would be pure overhead.
func TestLoadCatalogChain(t *testing.T) {
	files := fstest.MapFS{
		"i18n/en.json":      {Data: []byte(`{"Close":"Close"}`)},
		"i18n/en-XA.json":   {Data: []byte(`{"Close":"[Çļöšé ··]"}`)},
		"i18n/zh.json":      {Data: []byte(`{"Close":"关闭","Open":"打开"}`)},
		"i18n/zh-Hant.json": {Data: []byte(`{"Close":"關閉"}`)},
		"i18n/broken.json":  {Data: []byte(`{not json`)},
		"i18n/de-CH.json":   {Data: []byte(`{"Close":"Schliessen"}`)},
		"i18n/he.json":      {Data: []byte(`{"Close":"סגור"}`)},
	}
	read := func(p string) ([]byte, error) { return fs.ReadFile(files, p) }
	cases := []struct {
		locale, want string
	}{
		{"en-XA", "[Çļöšé ··]"},
		{"zh-Hant-TW", "關閉"},
		{"zh", "关闭"},
		{"de-CH", "Schliessen"},
		{"iw-IL", "סגור"},
		{"he-IL", "סגור"},
		{"de", ""},
		{"en", ""},
		{"en-GB", ""},
		{"broken", ""},
		{"", ""},
		{"../etc", ""},
	}
	for _, c := range cases {
		got := LoadCatalog(read, c.locale)["Close"]
		if got != c.want {
			t.Errorf("LoadCatalog(%q)[Close] = %q, want %q", c.locale, got, c.want)
		}
	}
	// Per message, not per file: zh-Hant has no Open, so it comes from zh.
	if got := LoadCatalog(read, "zh-Hant-TW")["Open"]; got != "打开" {
		t.Errorf("LoadCatalog(zh-Hant-TW)[Open] = %q, want the zh fallback", got)
	}
}

// A registered catalogue source adds its messages to the core catalogue, along
// the same chain, but never re-words a message the core translates.
func TestRegisterCatalogFS(t *testing.T) {
	core := fstest.MapFS{
		"i18n/fr.json": {Data: []byte(`{"Close":"Fermer"}`)},
	}
	read := func(p string) ([]byte, error) { return fs.ReadFile(core, p) }
	extra := fstest.MapFS{
		"cat/fr.json":    {Data: []byte(`{"Close":"Fermez","Tunnel":"Tunnel FR"}`)},
		"cat/fr-CA.json": {Data: []byte(`{"Tunnel":"Tunnel CA"}`)},
		"cat/de.json":    {Data: []byte(`{"Tunnel":"Tunnel DE"}`)},
	}
	unregister := RegisterCatalogFS(extra, "cat")
	t.Cleanup(unregister)

	fr := LoadCatalog(read, "fr")
	if fr["Close"] != "Fermer" {
		t.Errorf("Close = %q: a registered source re-worded a core message", fr["Close"])
	}
	if fr["Tunnel"] != "Tunnel FR" {
		t.Errorf("Tunnel = %q, want the registered fr message", fr["Tunnel"])
	}
	if got := LoadCatalog(read, "fr-CA")["Tunnel"]; got != "Tunnel CA" {
		t.Errorf("fr-CA Tunnel = %q, want the source's most specific file", got)
	}
	// The core has no de at all; the source alone still makes a catalogue.
	if got := LoadCatalog(read, "de")["Tunnel"]; got != "Tunnel DE" {
		t.Errorf("de Tunnel = %q, want the registered de message", got)
	}

	unregister()
	if got := LoadCatalog(read, "fr")["Tunnel"]; got != "" {
		t.Errorf("after unregistering, Tunnel = %q", got)
	}
}

// A language is available when the core catalogue directory has its
// catalogue: the source list and the pseudo-locale are not languages to offer,
// a file that is not a catalogue name is skipped, tags come out canonical and
// sorted, and a second tree (the on-disk one) adds to the first without
// repeating it. A registered source adds none.
func TestAvailableLocales(t *testing.T) {
	embedded := fstest.MapFS{
		"i18n/en.json":    {Data: []byte(`{}`)},
		"i18n/en-XA.json": {Data: []byte(`{}`)},
		"i18n/fr.json":    {Data: []byte(`{}`)},
		"i18n/README.md":  {Data: []byte(`x`)},
		"i18n/en_GB.json": {Data: []byte(`{}`)},
		"other/de.json":   {Data: []byte(`{}`)},
	}
	if got := AvailableLocales(embedded); !slices.Equal(got, []string{"fr"}) {
		t.Fatalf("AvailableLocales = %q, want [fr]", got)
	}
	disk := fstest.MapFS{
		"i18n/fr.json":         {Data: []byte(`{}`)},
		"i18n/zh-hant-tw.json": {Data: []byte(`{}`)},
		"i18n/de.json":         {Data: []byte(`{}`)},
	}
	t.Cleanup(RegisterCatalogFS(fstest.MapFS{"i18n/ja.json": {Data: []byte(`{}`)}}, "i18n"))
	if got := AvailableLocales(embedded, disk); !slices.Equal(got, []string{"de", "fr", "zh-Hant-TW"}) {
		t.Fatalf("AvailableLocales over two trees = %q, want [de fr zh-Hant-TW]", got)
	}
	if got := AvailableLocales(fstest.MapFS{}); got == nil || len(got) != 0 {
		t.Fatalf("no catalogue directory: got %#v, want an empty, non-nil list", got)
	}
}
