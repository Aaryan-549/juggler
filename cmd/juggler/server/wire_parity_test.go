//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
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
// Inbound: the cases of realtime_loop.go's `switch generic.Type`, both ways.
// Outbound: every frame the manifest lists must appear as a string in the
// server's source, and every string the server puts where a frame type goes
// (a `"type":` map key or a `Type:` field) must be declared — as a frame, or
// as one of the worker messages the server hands the worker itself.
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
	inbound, anyLiteral, typePosition := map[string]bool{}, map[string]bool{}, map[string]bool{}
	for _, p := range paths {
		if strings.HasSuffix(p, "_test.go") {
			continue
		}
		f, err := parser.ParseFile(fset, p, nil, 0)
		if err != nil {
			t.Fatalf("parse %s: %v", p, err)
		}
		ast.Inspect(f, func(n ast.Node) bool {
			switch n := n.(type) {
			case *ast.BasicLit:
				if v := wireStrLit(n); v != "" {
					anyLiteral[v] = true
				}
			case *ast.KeyValueExpr:
				v := wireStrLit(n.Value)
				if v == "" {
					return true
				}
				if id, ok := n.Key.(*ast.Ident); ok && id.Name == "Type" {
					typePosition[v] = true
				}
				if wireStrLit(n.Key) == "type" {
					typePosition[v] = true
				}
			case *ast.SwitchStmt:
				sel, ok := n.Tag.(*ast.SelectorExpr)
				if !ok || sel.Sel.Name != "Type" || p != "realtime_loop.go" {
					return true
				}
				if id, ok := sel.X.(*ast.Ident); !ok || id.Name != "generic" {
					return true
				}
				for _, stmt := range n.Body.List {
					for _, e := range stmt.(*ast.CaseClause).List {
						if v := wireStrLit(e); v != "" {
							inbound[v] = true
						}
					}
				}
			}
			return true
		})
	}

	if len(inbound) < 8 {
		t.Fatalf("found only %d cases in realtime_loop.go's switch on generic.Type (%v) — the shape this scan looks for has changed", len(inbound), sortedKeys(inbound))
	}
	if len(typePosition) < 15 {
		t.Fatalf("found only %d frame-type literals in the server (%v) — the shape this scan looks for has changed", len(typePosition), sortedKeys(typePosition))
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

	known := map[string]bool{}
	for _, v := range m.Server.Inbound {
		known[v] = true
	}
	for _, v := range m.Worker.Inbound {
		known[v] = true
	}
	for _, v := range m.Worker.ProviderTypes.Types {
		known[v] = true
	}
	for _, o := range m.Server.Outbound {
		known[o.Type] = true
		if !anyLiteral[o.Type] {
			t.Errorf("%s declares server frame %q, but no such string appears in the server's source", wireFixture, o.Type)
		}
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
