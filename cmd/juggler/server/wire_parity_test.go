//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"go/types"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// wireFixture is the vocabulary shared with the JS half
// (unit:wire-protocol-parity) and with the worker's TestWireParityWorker*.
const wireFixture = "../../../web/js-tests/fixtures/wire-protocol.json"

type serverWireManifest struct {
	Worker struct {
		Inbound       []string `json:"inbound"`
		ProviderTypes struct {
			Types []string `json:"types"`
		} `json:"providerTypes"`
	} `json:"worker"`
	Server struct {
		Inbound  []string `json:"inbound"`
		Outbound []struct {
			Type      string `json:"type"`
			HandledBy string `json:"handledBy"`
		} `json:"outbound"`
	} `json:"server"`
}

func sortedKeys(s map[string]bool) []string {
	out := make([]string, 0, len(s))
	for v := range s {
		out = append(out, v)
	}
	sort.Strings(out)
	return out
}

func missingFrom(s, other map[string]bool) []string {
	var out []string
	for _, v := range sortedKeys(s) {
		if !other[v] {
			out = append(out, v)
		}
	}
	return out
}

func wireStrLit(e ast.Expr) string {
	lit, ok := e.(*ast.BasicLit)
	if !ok || lit.Kind != token.STRING {
		return ""
	}
	v, err := strconv.Unquote(lit.Value)
	if err != nil {
		return ""
	}
	return v
}

// TestWireParityServer pins the realtime frame vocabulary to the manifest.
//
// Inbound: the cases of realtime_loop.go's `switch frameType(generic.Type)`,
// both ways. Outbound: allOutboundFrames must equal the manifest's frames, and
// each of its constants must be used outside wire_vocab.go — a frame nothing
// sends is not sent, whatever the list says. A frame type written as a literal
// where a frame type goes (a `"type":` map key or a `Type:` field) fails: the
// constants are the vocabulary. Every other literal there must be declared, as
// one of the worker messages the server hands the worker itself or a provider
// body type.
func TestWireParityServer(t *testing.T) {
	data, err := os.ReadFile(wireFixture)
	if err != nil {
		t.Fatalf("read %s: %v", wireFixture, err)
	}
	var m serverWireManifest
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("parse %s: %v", wireFixture, err)
	}

	paths, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(paths)
	fset := token.NewFileSet()
	files := map[string]*ast.File{}
	frameConst := map[string]string{} // frameType constant → the frame it names
	for _, p := range paths {
		if strings.HasSuffix(p, "_test.go") {
			continue
		}
		f, err := parser.ParseFile(fset, p, nil, 0)
		if err != nil {
			t.Fatalf("parse %s: %v", p, err)
		}
		files[p] = f
		ast.Inspect(f, func(n ast.Node) bool {
			if vs, ok := n.(*ast.ValueSpec); ok {
				if typ, ok := vs.Type.(*ast.Ident); ok && typ.Name == "frameType" {
					for i, name := range vs.Names {
						if i < len(vs.Values) {
							frameConst[name.Name] = wireStrLit(vs.Values[i])
						}
					}
				}
			}
			return true
		})
	}

	frameTypes := map[string]bool{}
	for _, v := range m.Server.Inbound {
		frameTypes[v] = true
	}
	for _, o := range m.Server.Outbound {
		frameTypes[o.Type] = true
	}

	inbound, used, typePosition := map[string]bool{}, map[string]bool{}, map[string]bool{}
	typedPositions := 0
	var literal []string
	for _, p := range paths {
		f := files[p]
		if f == nil {
			continue
		}
		ast.Inspect(f, func(n ast.Node) bool {
			switch n := n.(type) {
			case *ast.Ident:
				if p != "wire_vocab.go" {
					used[n.Name] = true
				}
			case *ast.KeyValueExpr:
				id, isField := n.Key.(*ast.Ident)
				if (!isField || id.Name != "Type") && wireStrLit(n.Key) != "type" {
					return true
				}
				if v := wireStrLit(n.Value); v != "" {
					typePosition[v] = true
					if frameTypes[v] {
						literal = append(literal, fmt.Sprintf("%s:%d: frame type %q", p, fset.Position(n.Pos()).Line, v))
					}
				} else if constant, ok := n.Value.(*ast.Ident); ok && frameConst[constant.Name] != "" {
					typedPositions++
				}
			case *ast.SwitchStmt:
				if p != "realtime_loop.go" || !isFrameTypeOfGenericType(n.Tag) {
					return true
				}
				for _, stmt := range n.Body.List {
					for _, e := range stmt.(*ast.CaseClause).List {
						if id, ok := e.(*ast.Ident); ok && frameConst[id.Name] != "" {
							inbound[frameConst[id.Name]] = true
						} else {
							t.Errorf("realtime_loop.go dispatches on %s, which is not a frameType constant", types.ExprString(e))
						}
					}
				}
			}
			return true
		})
	}

	if len(inbound) < 8 {
		t.Fatalf("found only %d cases in realtime_loop.go's switch on frameType(generic.Type) (%v) — the shape this scan looks for has changed", len(inbound), sortedKeys(inbound))
	}
	if typedPositions < 15 {
		t.Fatalf("found only %d frame types named by constant in the server — the shape this scan looks for has changed", typedPositions)
	}
	sort.Strings(literal)
	for _, l := range literal {
		t.Error(l + " is a literal — use its frameType constant (wire_vocab.go)")
	}

	declaredIn := map[string]bool{}
	for _, v := range m.Server.Inbound {
		declaredIn[v] = true
	}
	if extra := missingFrom(inbound, declaredIn); len(extra) > 0 {
		t.Errorf("realtime_loop.go dispatches %v, which %s does not declare under server.inbound", extra, wireFixture)
	}
	if stale := missingFrom(declaredIn, inbound); len(stale) > 0 {
		t.Errorf("%s declares server.inbound %v, which realtime_loop.go no longer dispatches", wireFixture, stale)
	}

	nameOf := map[string]string{}
	for name, v := range frameConst {
		nameOf[v] = name
	}
	for _, f := range allOutboundFrames {
		if name := nameOf[string(f)]; name == "" || !used[name] {
			t.Errorf("allOutboundFrames has %q, but nothing outside wire_vocab.go uses its constant — the server does not send it", f)
		}
	}

	known := map[string]bool{}
	for v := range frameTypes {
		known[v] = true
	}
	for _, v := range m.Worker.Inbound {
		known[v] = true
	}
	for _, v := range m.Worker.ProviderTypes.Types {
		known[v] = true
	}
	if undeclared := missingFrom(typePosition, known); len(undeclared) > 0 {
		t.Errorf("the server sends frame types %v, which %s does not declare under server.outbound", undeclared, wireFixture)
	}

	declaredOut := map[string]bool{}
	for _, o := range m.Server.Outbound {
		declaredOut[o.Type] = true
	}
	for _, c := range []struct {
		what     string
		vocab    []frameType
		declared map[string]bool
	}{
		{"allInboundFrames", allInboundFrames, declaredIn},
		{"allOutboundFrames", allOutboundFrames, declaredOut},
	} {
		vocab := map[string]bool{}
		for _, f := range c.vocab {
			if vocab[string(f)] {
				t.Errorf("%s (wire_vocab.go) lists %q twice", c.what, f)
			}
			vocab[string(f)] = true
		}
		if extra := missingFrom(vocab, c.declared); len(extra) > 0 {
			t.Errorf("%s (wire_vocab.go) has %v, which %s does not declare", c.what, extra, wireFixture)
		}
		if stale := missingFrom(c.declared, vocab); len(stale) > 0 {
			t.Errorf("%s declares %v, which %s (wire_vocab.go) does not list", wireFixture, stale, c.what)
		}
	}
}

// isFrameTypeOfGenericType reports whether e is exactly frameType(generic.Type).
func isFrameTypeOfGenericType(e ast.Expr) bool {
	call, ok := e.(*ast.CallExpr)
	if !ok || len(call.Args) != 1 {
		return false
	}
	if fn, ok := call.Fun.(*ast.Ident); !ok || fn.Name != "frameType" {
		return false
	}
	sel, ok := call.Args[0].(*ast.SelectorExpr)
	if !ok || sel.Sel.Name != "Type" {
		return false
	}
	id, ok := sel.X.(*ast.Ident)
	return ok && id.Name == "generic"
}
