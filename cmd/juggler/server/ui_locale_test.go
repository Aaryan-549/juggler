//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"encoding/json"
	"html/template"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/gorilla/mux"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/server/handlers"
	"juggler/internal/userpaths/userpathstest"
	"juggler/web"
)

// The UI language is stored by the settings API like any other section: a
// language tag is kept, clearing it is allowed, and anything else is refused
// before it can reach the page markup.
func TestPutSettingsUILocale(t *testing.T) {
	userpathstest.Isolate(t)
	s := &Server{settings: newSettingsStore()}

	putSettings(t, s, `{"uiLocale":"en-XA"}`, http.StatusOK)
	if got := s.settings.get().UILocale; got != "en-XA" {
		t.Fatalf("stored uiLocale = %q, want en-XA", got)
	}
	// A PUT that omits it leaves it alone.
	putSettings(t, s, `{"updates":{"mode":"notify"}}`, http.StatusOK)
	if got := s.settings.get().UILocale; got != "en-XA" {
		t.Fatalf("an unrelated PUT changed uiLocale to %q", got)
	}
	putSettings(t, s, `{"uiLocale":"en_GB"}`, http.StatusBadRequest)
	if got := s.settings.get().UILocale; got != "en-XA" {
		t.Fatalf("a refused PUT changed uiLocale to %q", got)
	}
	// A tag the browser's Intl would reject is refused too.
	putSettings(t, s, `{"uiLocale":"en-US-abc"}`, http.StatusBadRequest)
	if got := s.settings.get().UILocale; got != "en-XA" {
		t.Fatalf("a refused PUT changed uiLocale to %q", got)
	}
	// A tag in the wrong case is stored canonically.
	putSettings(t, s, `{"uiLocale":"zh-hant-tw"}`, http.StatusOK)
	if got := s.settings.get().UILocale; got != "zh-Hant-TW" {
		t.Fatalf("stored uiLocale = %q, want zh-Hant-TW", got)
	}
	putSettings(t, s, `{"uiLocale":"IW-il"}`, http.StatusOK)
	if got := s.settings.get().UILocale; got != "he-IL" {
		t.Fatalf("stored uiLocale = %q, want he-IL", got)
	}
	putSettings(t, s, `{"uiLocale":""}`, http.StatusOK)
	if got := s.settings.get().UILocale; got != "" {
		t.Fatalf("clearing left uiLocale = %q", got)
	}
}

// A catalogue is looked up along the language's chain, most specific first,
// and never as the English key list: en.json lists the source strings for
// translators, and serving it as a translation would be pure overhead.
func TestLoadUICatalogChain(t *testing.T) {
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
		got := loadUICatalog(read, c.locale)["Close"]
		if got != c.want {
			t.Errorf("loadUICatalog(%q)[Close] = %q, want %q", c.locale, got, c.want)
		}
	}
	// Per message, not per file: zh-Hant has no Open, so it comes from zh.
	if got := loadUICatalog(read, "zh-Hant-TW")["Open"]; got != "打开" {
		t.Errorf("loadUICatalog(zh-Hant-TW)[Open] = %q, want the zh fallback", got)
	}
}

// serveIndex writes the chosen language into the page before it paints: the
// lang attribute, the locale the i18n module reads, and the catalogue inline,
// so the first frame is already in that language.
func TestIndexInjectsUILocale(t *testing.T) {
	userpathstest.Isolate(t)
	mgr, err := core.NewSessionManagerForPath(t.TempDir())
	if err != nil {
		t.Fatalf("NewSessionManagerForPath: %v", err)
	}
	t.Cleanup(mgr.Shutdown)

	s := &Server{router: mux.NewRouter(), settings: newSettingsStore()}
	s.projectState.Store(&projectState{sessionManager: mgr, projectPath: t.TempDir()})
	if err := s.loadIndexTemplate(); err != nil {
		t.Fatalf("loadIndexTemplate: %v", err)
	}
	serve := func() string {
		req := httptest.NewRequest(http.MethodGet, "/?window=1", nil)
		req.RemoteAddr = localViewerAddr
		rec := httptest.NewRecorder()
		s.serveIndex(rec, req)
		return rec.Body.String()
	}

	page := serve()
	if !strings.Contains(page, `<html lang="en">`) {
		t.Fatalf("with no language chosen the page must be plain English: %.200q", page)
	}
	if strings.Contains(page, "juggler-ui-catalog") {
		t.Fatal("with no language chosen no catalogue is sent")
	}

	putSettings(t, s, `{"uiLocale":"en-XA"}`, http.StatusOK)
	page = serve()
	if !strings.Contains(page, `<html lang="en-XA" data-ui-locale="en-XA">`) {
		t.Fatalf("lang and data-ui-locale not injected: %.200q", page)
	}
	m := regexp.MustCompile(`(?s)<script type="application/json" id="juggler-ui-catalog"[^>]*>(.*?)</script>`).FindStringSubmatch(page)
	if m == nil {
		t.Fatal("the en-XA catalogue was not inlined")
	}
	var messages map[string]string
	if err := json.Unmarshal([]byte(m[1]), &messages); err != nil {
		t.Fatalf("inlined catalogue is not JSON: %v (%.200q)", err, m[1])
	}
}

// The catalogue is inlined inside a <script> element, so a message containing
// markup must not be able to close it. html/template's JS escaping is what
// guarantees that; this pins that the template hands it a value, not a string
// spliced in raw.
func TestInlinedCatalogueCannotCloseItsScript(t *testing.T) {
	tmpl := template.Must(template.New("x").Parse(
		`<script type="application/json" id="juggler-ui-catalog">{{.UICatalog}}</script>`))
	var b strings.Builder
	evil := map[string]string{"x": "</script><script>alert(1)</script>"}
	if err := tmpl.Execute(&b, struct{ UICatalog map[string]string }{evil}); err != nil {
		t.Fatalf("execute: %v", err)
	}
	out := b.String()
	if strings.Count(out, "</script>") != 1 {
		t.Fatalf("a message closed the script element: %q", out)
	}
	inner := strings.TrimSuffix(strings.TrimPrefix(out, `<script type="application/json" id="juggler-ui-catalog">`), "</script>")
	var back map[string]string
	if err := json.Unmarshal([]byte(inner), &back); err != nil || back["x"] != evil["x"] {
		t.Fatalf("round trip through the page lost the message: %v %q", err, inner)
	}
}

// The engine (in a worker or under Node) has no page to read, so it asks for
// the catalogue over the API.
func TestUICatalogRoute(t *testing.T) {
	s := &Server{}
	get := func(target string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		s.handleUICatalog(rec, httptest.NewRequest(http.MethodGet, target, nil))
		return rec
	}
	rec := get("/api/i18n/catalog?locale=en-XA")
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Locale   string            `json:"locale"`
		Messages map[string]string `json:"messages"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Locale != "en-XA" || body.Messages == nil {
		t.Fatalf("got %+v, want the en-XA catalogue", body)
	}
	if !strings.Contains(rec.Body.String(), `"extensions":{}`) {
		t.Fatalf("with no extensions the field is an empty object, not absent or null: %s", rec.Body.String())
	}
	if rec := get("/api/i18n/catalog?locale=en_GB"); rec.Code != http.StatusBadRequest {
		t.Fatalf("an invalid locale: status %d, want 400", rec.Code)
	}
}

// The built-in extensions ship their own catalogues, embedded with them: the
// generated en-XA of each reaches a client by its extension id.
func TestBuiltinExtensionsServeTheirCatalogues(t *testing.T) {
	got := handlers.NewExtensionsAPI(web.Files, "", "").Catalogs("en-XA")
	for _, id := range []string{"@juggler/core", "@juggler/mcp", "@juggler/about", "@juggler/exa"} {
		if len(got[id]) == 0 {
			t.Errorf("%s: no en-XA catalogue served (got ids %v)", id, keys(got))
		}
	}
	if name := got["@juggler/core"]["Juggler Core"]; !strings.HasPrefix(name, "[") || name == "Juggler Core" {
		t.Errorf("the core extension's name is not pseudo-localised: %q", name)
	}
}

// keys lists a map's keys, for a failure message.
func keys(m map[string]map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// The same response carries each extension's catalogue under its id, so one
// request gives a client everything it registers.
func TestUICatalogRouteCarriesExtensionCatalogues(t *testing.T) {
	builtin := fstest.MapFS{
		"sdk/version.js": {Data: []byte("export const ENGINE_API_VERSION = '1.1.0';")},
		"extensions/x/juggler.extension.json": {Data: []byte(`{"id":"@t/x","name":"X","version":"1.0.0",
			"engineApi":"^1.1.0","provides":{"commands":["c/*-command-type.js"],"i18n":"i18n"}}`)},
		"extensions/x/c/a-command-type.js": {Data: []byte("//")},
		"extensions/x/i18n/en-XA.json":     {Data: []byte(`{"Go":"[Ĝö ··]"}`)},
	}
	s := &Server{serverAPIs: serverAPIs{extensionsAPI: handlers.NewExtensionsAPI(builtin, "", "")}}
	rec := httptest.NewRecorder()
	s.handleUICatalog(rec, httptest.NewRequest(http.MethodGet, "/api/i18n/catalog?locale=en-XA", nil))
	var body struct {
		Extensions map[string]map[string]string `json:"extensions"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v (%s)", err, rec.Body.String())
	}
	if body.Extensions["@t/x"]["Go"] != "[Ĝö ··]" {
		t.Fatalf("extensions = %v, want @t/x's en-XA catalogue", body.Extensions)
	}
}
