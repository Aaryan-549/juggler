//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"juggler/internal/srcroot"
)

// executorImportRe matches one static import of a suite module in
// integration-test-executor.js: the bindings it takes and the module it names.
var executorImportRe = regexp.MustCompile(`(?m)^import\s*\{([^}]*)\}\s*from\s*'\.\./(integration-tests|unit-tests)/([^']+)'`)

// TestAllTestFilesRegistered checks that every JS test file in the integration-tests/
// and unit-tests/ directories is imported in integration-test-executor.js, and
// that everything imported from one is used there. This prevents silently
// dropped tests when a file is added but the executor is not updated.
//
// Both halves are exact. A file counts as imported only when an import
// statement names it as its module — a mention in a comment, or a name that is
// the tail of another file's (`foo-test.js` inside `bar-foo-test.js`), does
// not. And an imported binding must appear again outside the import, because a
// suite imported but never put in a table is exactly as dropped as one never
// imported.
func TestAllTestFilesRegistered(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping test registration check in short mode")
	}

	root, err := srcroot.Find(".")
	if err != nil {
		t.Fatalf("cannot find project root: %v", err)
	}

	executorPath := filepath.Join(root, "web", "js-tests", "utilities", "integration-test-executor.js")
	executorBytes, err := os.ReadFile(executorPath)
	if err != nil {
		t.Fatalf("cannot read integration-test-executor.js: %v", err)
	}
	executorSrc := string(executorBytes)

	imported := make(map[string]bool)
	// The source with every suite import removed, so a binding found in it is
	// a use rather than its own import.
	body := executorImportRe.ReplaceAllString(executorSrc, "")
	for _, m := range executorImportRe.FindAllStringSubmatch(executorSrc, -1) {
		module := m[2] + "/" + m[3]
		imported[module] = true
		for _, part := range strings.Split(m[1], ",") {
			fields := strings.Fields(part)
			if len(fields) == 0 {
				continue
			}
			local := fields[len(fields)-1] // `runTests as runFooTests` → runFooTests
			if !regexp.MustCompile(`\b` + regexp.QuoteMeta(local) + `\b`).MatchString(body) {
				t.Errorf("%s is imported from %s in integration-test-executor.js but never used there, "+
					"so the suite it names never runs", local, module)
			}
		}
	}

	for _, dir := range []string{"integration-tests", "unit-tests"} {
		entries, err := os.ReadDir(filepath.Join(root, "web", "js-tests", dir))
		if err != nil {
			t.Fatalf("cannot read dir %s: %v", dir, err)
		}
		for _, e := range entries {
			if e.IsDir() || filepath.Ext(e.Name()) != ".js" {
				continue
			}
			if module := dir + "/" + e.Name(); !imported[module] {
				t.Errorf("test file %q is not imported in integration-test-executor.js", module)
			}
		}
	}
	if len(imported) == 0 {
		t.Fatal("found no suite imports in integration-test-executor.js — has the import form changed?")
	}
}
