//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package builtin

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"slices"
	"strings"
	"testing"
)

// notProviders are the packages under providers/ that have a Register func but
// are not a model provider of their own.
var notProviders = []string{
	"builtin",    // this list, which registers the rest
	"streamidle", // installs the stream idle-timeout resolver
}

// registersAProvider reports whether the package in dir declares a top-level
// `func Register()`, the shape every provider package registers itself with.
func registersAProvider(t *testing.T, dir string) bool {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(dir, "*.go"))
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range files {
		if strings.HasSuffix(name, "_test.go") {
			continue
		}
		f, err := parser.ParseFile(token.NewFileSet(), name, nil, parser.SkipObjectResolution)
		if err != nil {
			t.Fatalf("parse %s: %v", name, err)
		}
		for _, decl := range f.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if ok && fn.Recv == nil && fn.Name.Name == "Register" && fn.Type.Params.NumFields() == 0 {
				return true
			}
		}
	}
	return false
}

// TestAllCoversEveryProviderPackage: a provider package that is not on the list
// is a provider the app never registers and the catalog audit never checks, and
// nothing else would notice.
func TestAllCoversEveryProviderPackage(t *testing.T) {
	listed := map[string]bool{}
	for _, p := range All {
		name := runtime.FuncForPC(reflect.ValueOf(p.Register).Pointer()).Name()
		pkg := strings.TrimSuffix(name, ".Register")
		listed[pkg[strings.LastIndex(pkg, "/")+1:]] = true
	}

	dirs, err := os.ReadDir("..")
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range dirs {
		if !d.IsDir() || slices.Contains(notProviders, d.Name()) {
			continue
		}
		if registersAProvider(t, filepath.Join("..", d.Name())) && !listed[d.Name()] {
			t.Errorf("providers/%s registers a provider but is not in builtin.All", d.Name())
		}
	}
	if len(listed) != len(All) {
		t.Errorf("builtin.All lists %d providers from %d packages; a package is listed twice", len(All), len(listed))
	}
}
