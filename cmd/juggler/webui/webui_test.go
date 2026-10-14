//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package webui

import (
	"io/fs"
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
