//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"go/ast"
	"go/parser"
	"go/token"
	"go/types"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// shallowImporter answers every import with an empty, complete package. The
// checker then reports each use of an imported name as an error and carries
// on, which is all a guard about this package's own types needs: every
// expression built from the worker's own declarations still gets its type,
// without type-checking the module graph from source.
type shallowImporter struct{}

func (shallowImporter) Import(p string) (*types.Package, error) {
	name := path.Base(p)
	if i := strings.IndexAny(name, ".-"); i > 0 {
		name = name[:i]
	}
	pkg := types.NewPackage(p, name)
	pkg.MarkComplete()
	return pkg, nil
}

// TestRunEntryIsIndexedOnlyInRunEntryGo holds the run entry's fields behind its
// accessors. runEntry is a map so the doc is written back with every key it
// came with, but that makes entry["x"] legal anywhere, and an index outside
// run_entry.go is a field read or write that skips the accessor's kind
// handling (claimedAt arrives as any numeric kind) and the one place a field's
// meaning is written down. Found by type, not by name: whatever a variable is
// called, if it is a runEntry it is indexed only in run_entry.go.
func TestRunEntryIsIndexedOnlyInRunEntryGo(t *testing.T) {
	paths, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	fset := token.NewFileSet()
	var files []*ast.File
	for _, p := range paths {
		if strings.HasSuffix(p, "_test.go") {
			continue
		}
		f, err := parser.ParseFile(fset, p, nil, 0)
		if err != nil {
			t.Fatalf("parse %s: %v", p, err)
		}
		files = append(files, f)
	}

	info := &types.Info{Types: map[ast.Expr]types.TypeAndValue{}}
	conf := types.Config{Importer: shallowImporter{}, Error: func(error) {}}
	pkg, _ := conf.Check("worker", fset, files, info)
	obj := pkg.Scope().Lookup("runEntry")
	if obj == nil {
		t.Fatal("runEntry is not declared in this package")
	}
	runEntryType := obj.Type()

	// The guard is only as good as the type-check behind it: if the shallow
	// importer left runEntry expressions untyped, nothing would be found and
	// the test would pass for the wrong reason.
	typed := 0
	var bad []string
	for _, f := range files {
		name := filepath.Base(fset.Position(f.Pos()).Filename)
		ast.Inspect(f, func(n ast.Node) bool {
			e, ok := n.(ast.Expr)
			if !ok {
				return true
			}
			if tv, ok := info.Types[e]; ok && types.Identical(tv.Type, runEntryType) {
				typed++
			}
			ix, ok := n.(*ast.IndexExpr)
			if !ok || name == "run_entry.go" {
				return true
			}
			if tv, ok := info.Types[ix.X]; ok && types.Identical(tv.Type, runEntryType) {
				bad = append(bad, fset.Position(ix.Pos()).String()+": "+types.ExprString(ix))
			}
			return true
		})
	}
	if typed < 20 {
		t.Fatalf("the type-check resolved only %d runEntry-typed expressions; it cannot be trusted to find an index", typed)
	}
	sort.Strings(bad)
	for _, b := range bad {
		t.Errorf("%s indexes a runEntry outside run_entry.go — use or add an accessor there", b)
	}
}
