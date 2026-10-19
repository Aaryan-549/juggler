//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"strings"
	"testing"
)

// TestEveryYcrdtHoldDefersItsRelease pins the rule that no hold of the doc lock
// can outlive a panic. ycrdtMu is process-wide and not reentrant, so a hold a
// panic leaves behind freezes every conversation in the process; the recovers
// that catch a turn's or a handler's panic can then only end the process
// (requireDocLockAfterPanic). A hold whose release is deferred cannot be left
// behind. So every ycrdtMu.Lock() in production code is followed at once by
// defer ycrdtMu.Unlock() — directly, or through withYDoc, which does exactly
// that — and nothing releases the lock by hand.
//
// A source walk over the package's production files.
func TestEveryYcrdtHoldDefersItsRelease(t *testing.T) {
	fset := token.NewFileSet()
	paths, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	scanned := 0
	for _, p := range paths {
		if strings.HasSuffix(p, "_test.go") {
			continue
		}
		f, err := parser.ParseFile(fset, p, nil, 0)
		if err != nil {
			t.Fatalf("parsing %s: %v", p, err)
		}
		scanned++
		ast.Inspect(f, func(n ast.Node) bool {
			var list []ast.Stmt
			switch n := n.(type) {
			case *ast.BlockStmt:
				list = n.List
			case *ast.CaseClause:
				list = n.Body
			case *ast.CommClause:
				list = n.Body
			default:
				return true
			}
			for i, s := range list {
				es, ok := s.(*ast.ExprStmt)
				if !ok {
					continue
				}
				call, ok := es.X.(*ast.CallExpr)
				if !ok {
					continue
				}
				switch {
				case isYcrdtMuCall(call, "Unlock"):
					t.Errorf("%s: ycrdtMu is released by hand; defer the release where the lock is taken, or use withYDoc",
						fset.Position(call.Pos()))
				case isYcrdtMuCall(call, "Lock"):
					if i+1 >= len(list) || !isDeferredYcrdtUnlock(list[i+1]) {
						t.Errorf("%s: ycrdtMu is taken without its release deferred on the next line; a panic in the hold would keep it",
							fset.Position(call.Pos()))
					}
				}
			}
			return true
		})
	}
	if scanned < 50 {
		t.Fatalf("scanned only %d production files; the glob is not seeing the package", scanned)
	}
}

// isDeferredYcrdtUnlock reports whether s is `defer ycrdtMu.Unlock()`.
func isDeferredYcrdtUnlock(s ast.Stmt) bool {
	d, ok := s.(*ast.DeferStmt)
	return ok && isYcrdtMuCall(d.Call, "Unlock")
}
