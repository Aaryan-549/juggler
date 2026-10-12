//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package testing

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// TestExtensionTestsDiscoversBothKinds: an extension declares its unit suites
// in provides.tests and its integration modules in provides.integrationTests,
// and the harness endpoint serves each list from the manifest alone. A unit
// suite is named after its file; an integration module names its own tests, so
// only its path is served.
func TestExtensionTestsDiscoversBothKinds(t *testing.T) {
	extDir := t.TempDir()
	demo := filepath.Join(extDir, "demo")
	files := map[string]string{
		"juggler.extension.json": `{"id": "demo", "name": "Demo", "version": "1.0.0", "provides": {
			"tests": ["_tests/*-test.js"],
			"integrationTests": ["_tests/integration/*-tests.js"]
		}}`,
		"_tests/demo-test.js":               "export async function runTests() {}",
		"_tests/integration/demo-tests.js":  "export const tests = [];",
		"_tests/integration/helper.js":      "export {};",
		"_tests/integration/other-tests.js": "export const tests = [];",
	}
	for rel, content := range files {
		p := filepath.Join(demo, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	api := &TestAPI{webExtDir: extDir}
	rec := httptest.NewRecorder()
	api.HandleExtensionTests(rec, httptest.NewRequest(http.MethodGet, "/api/test/extension-tests", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	var got struct {
		Tests              []extensionTest `json:"tests"`
		IntegrationModules []string        `json:"integrationModules"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	wantTests := []extensionTest{{Name: "unit:demo", Path: "/extensions/demo/_tests/demo-test.js"}}
	if !reflect.DeepEqual(got.Tests, wantTests) {
		t.Errorf("tests = %+v, want %+v", got.Tests, wantTests)
	}
	wantModules := []string{
		"/extensions/demo/_tests/integration/demo-tests.js",
		"/extensions/demo/_tests/integration/other-tests.js",
	}
	if !reflect.DeepEqual(got.IntegrationModules, wantModules) {
		t.Errorf("integrationModules = %v, want %v", got.IntegrationModules, wantModules)
	}
}
