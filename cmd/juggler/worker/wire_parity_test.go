//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"maps"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// wireFixture is the vocabulary shared with the JS half
// (unit:wire-protocol-parity) and with the server's TestWireParityServer.
const wireFixture = "../../../web/js-tests/fixtures/wire-protocol.json"

type wireManifest struct {
	Worker struct {
		Inbound  []string `json:"inbound"`
		Outbound []struct {
			Type      string `json:"type"`
			GoEmits   bool   `json:"goEmits"`
			JSHandler bool   `json:"jsHandler"`
		} `json:"outbound"`
		ProviderTypes struct {
			Types []string `json:"types"`
		} `json:"providerTypes"`
		ItemTypes          []string `json:"itemTypes"`
		ProcessingStatuses []struct {
			Status     string `json:"status"`
			HoldsClaim bool   `json:"holdsClaim"`
			Emitted    bool   `json:"emitted"`
		} `json:"processingStatuses"`
		Activities     []string `json:"activities"`
		PendingRequest struct {
			Statuses []string `json:"statuses"`
			Kinds    []string `json:"kinds"`
		} `json:"pendingRequest"`
		DocKeys struct {
			Item        []string `json:"item"`
			ItemUntyped struct {
				Keys []string `json:"keys"`
			} `json:"itemUntyped"`
			ModelConfig     []string `json:"modelConfig"`
			Metadata        []string `json:"metadata"`
			PendingItem     []string `json:"pendingItem"`
			ProcessingState []string `json:"processingState"`
		} `json:"docKeys"`
	} `json:"worker"`
}

func loadWireManifest(t *testing.T) wireManifest {
	t.Helper()
	data, err := os.ReadFile(wireFixture)
	if err != nil {
		t.Fatalf("read %s: %v", wireFixture, err)
	}
	var m wireManifest
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("parse %s: %v", wireFixture, err)
	}
	return m
}

// workerSource is this package's production code, parsed: the vocabulary is
// read from what the worker actually does, not from a list kept beside it.
type workerSource struct {
	files map[string]*ast.File
}

func parseWorkerSource(t *testing.T) workerSource {
	t.Helper()
	paths, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	src := workerSource{files: map[string]*ast.File{}}
	fset := token.NewFileSet()
	for _, p := range paths {
		if strings.HasSuffix(p, "_test.go") {
			continue
		}
		f, err := parser.ParseFile(fset, p, nil, 0)
		if err != nil {
			t.Fatalf("parse %s: %v", p, err)
		}
		src.files[p] = f
	}
	return src
}

func (s workerSource) inspect(fn func(file string, n ast.Node) bool) {
	names := make([]string, 0, len(s.files))
	for name := range s.files {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		ast.Inspect(s.files[name], func(n ast.Node) bool { return fn(name, n) })
	}
}

// strLit is the value of a string literal, or "" for anything else.
func strLit(e ast.Expr) string {
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

type stringSet map[string]bool

func setOf(values ...string) stringSet {
	s := stringSet{}
	for _, v := range values {
		s[v] = true
	}
	return s
}

// vocabSet is one of wire_vocab.go's all… lists as a set.
func vocabSet[T ~string](values []T) stringSet {
	s := stringSet{}
	for _, v := range values {
		if s[string(v)] {
			panic("wire_vocab.go lists " + string(v) + " twice")
		}
		s[string(v)] = true
	}
	return s
}

func (s stringSet) sorted() []string {
	out := make([]string, 0, len(s))
	for v := range s {
		out = append(out, v)
	}
	sort.Strings(out)
	return out
}

// missingFrom lists the members of s that are not in other.
func (s stringSet) missingFrom(other stringSet) []string {
	var out []string
	for _, v := range s.sorted() {
		if !other[v] {
			out = append(out, v)
		}
	}
	return out
}

// requireSameSet fails, naming both directions of the difference, unless the
// set the source yielded equals the one the manifest declares.
func requireSameSet(t *testing.T, what string, fromSource, declared stringSet) {
	t.Helper()
	if extra := fromSource.missingFrom(declared); len(extra) > 0 {
		t.Errorf("%s: the worker uses %v, which %s does not declare — add them there", what, extra, wireFixture)
	}
	if stale := declared.missingFrom(fromSource); len(stale) > 0 {
		t.Errorf("%s: %s declares %v, which the worker no longer uses — remove them there", what, wireFixture, stale)
	}
}

// requireAtLeast guards a scan against matching nothing useful: a source
// refactor that changes the shape a scan looks for must fail here, not let
// every comparison below pass on two empty sets.
func requireAtLeast(t *testing.T, what string, got stringSet, n int) {
	t.Helper()
	if len(got) < n {
		t.Fatalf("%s: the source scan found only %d (%v), expected at least %d — the shape it looks for has changed", what, len(got), got.sorted(), n)
	}
}

// TestWireParityWorkerInbound pins the message types the worker dispatches to
// the manifest, in both directions. The worker's dispatch is a switch on the
// type in (*run).dispatchMessage; a case added or removed there without the
// manifest following fails here.
func TestWireParityWorkerInbound(t *testing.T) {
	m := loadWireManifest(t)
	src := parseWorkerSource(t)

	found := stringSet{}
	src.inspect(func(_ string, n ast.Node) bool {
		fn, ok := n.(*ast.FuncDecl)
		if !ok || fn.Name.Name != "dispatchMessage" || fn.Recv == nil {
			return true
		}
		ast.Inspect(fn.Body, func(n ast.Node) bool {
			sw, ok := n.(*ast.SwitchStmt)
			if !ok {
				return true
			}
			if sel, ok := sw.Tag.(*ast.SelectorExpr); !ok || sel.Sel.Name != "Type" {
				return true
			}
			for _, stmt := range sw.Body.List {
				for _, e := range stmt.(*ast.CaseClause).List {
					if v := strLit(e); v != "" {
						found[v] = true
					}
				}
			}
			return false
		})
		return false
	})

	requireAtLeast(t, "worker inbound", found, 30)
	requireSameSet(t, "worker inbound message types", found, setOf(m.Worker.Inbound...))
	requireSameSet(t, "allWorkerInbound (wire_vocab.go)", vocabSet(allWorkerInbound), setOf(m.Worker.Inbound...))
}

// TestWireParityWorkerOutbound pins the message types the worker sends.
//
// A type the manifest says the worker emits must appear as a string in its
// source (tool commands, for one, are chosen into a variable before they are
// sent, so "appears" is the strongest claim that holds for every sender). A
// type the manifest says it never emits must not appear where a message type
// goes — a `Type:` field, a `"type":` map key or a hand-built JSON head — and
// every string found there must be declared somewhere in the manifest.
func TestWireParityWorkerOutbound(t *testing.T) {
	m := loadWireManifest(t)
	src := parseWorkerSource(t)

	rawHead := regexp.MustCompile(`"type":"([^"]+)"`)
	anyLiteral := stringSet{}
	typePosition := stringSet{}
	src.inspect(func(_ string, n ast.Node) bool {
		switch n := n.(type) {
		case *ast.BasicLit:
			if v := strLit(n); v != "" {
				anyLiteral[v] = true
				for _, sub := range rawHead.FindAllStringSubmatch(v, -1) {
					typePosition[sub[1]] = true
					anyLiteral[sub[1]] = true
				}
			}
		case *ast.KeyValueExpr:
			v := strLit(n.Value)
			if v == "" {
				return true
			}
			if id, ok := n.Key.(*ast.Ident); ok && id.Name == "Type" {
				typePosition[v] = true
			}
			if strLit(n.Key) == "type" {
				typePosition[v] = true
			}
		}
		return true
	})
	requireAtLeast(t, "worker type-position literals", typePosition, 15)

	known := setOf(m.Worker.Inbound...)
	for _, v := range m.Worker.ProviderTypes.Types {
		known[v] = true
	}
	for _, v := range m.Worker.ItemTypes {
		known[v] = true
	}
	// The envelope the worker builds around its own messages for the server.
	known["worker-message"] = true
	for _, o := range m.Worker.Outbound {
		known[o.Type] = true
		switch {
		case o.GoEmits && !anyLiteral[o.Type]:
			t.Errorf("%s says the worker emits %q, but no such string appears in its source — set goEmits false, or remove the entry", wireFixture, o.Type)
		case !o.GoEmits && typePosition[o.Type]:
			t.Errorf("%s says the worker never emits %q, but it is used as a message type in the worker — set goEmits true", wireFixture, o.Type)
		}
	}
	if undeclared := typePosition.missingFrom(known); len(undeclared) > 0 {
		t.Errorf("the worker uses %v as message types, which %s does not declare — add each to worker.outbound (or providerTypes, if it is a provider request body type)", undeclared, wireFixture)
	}

	emits := stringSet{}
	for _, o := range m.Worker.Outbound {
		if o.GoEmits {
			emits[o.Type] = true
		}
	}
	requireSameSet(t, "allWorkerOutbound (wire_vocab.go)", vocabSet(allWorkerOutbound), emits)
}

// TestWireParityProcessingStatuses ties the statuses the worker writes to the
// manifest, and the manifest's holdsClaim to statusHoldsClaim. The JS half
// checks the same holdsClaim column against isRestingStatus, which is what
// keeps RESTING_STATUSES (web/js/model/processing-status.js) and
// statusHoldsClaim from drifting apart.
func TestWireParityProcessingStatuses(t *testing.T) {
	m := loadWireManifest(t)
	src := parseWorkerSource(t)

	// The processingStatus constants by name, so a write through
	// runEntry.setStatus(statusX) counts as writing statusX's value.
	statusConsts := map[string]string{}
	src.inspect(func(_ string, n ast.Node) bool {
		spec, ok := n.(*ast.ValueSpec)
		if !ok {
			return true
		}
		if typ, ok := spec.Type.(*ast.Ident); !ok || typ.Name != "processingStatus" {
			return true
		}
		for i, name := range spec.Names {
			if i < len(spec.Values) {
				statusConsts[name.Name] = strLit(spec.Values[i])
			}
		}
		return true
	})
	requireAtLeast(t, "processingStatus constants", setOf(slices.Collect(maps.Values(statusConsts))...), 5)

	statusWriters := setOf("sendStatus", "sendStatusText", "sendStatusWithCode", "writeProcessingState")
	stateMaps := setOf("entry", "state", "stateMap")
	written := stringSet{}
	src.inspect(func(_ string, n ast.Node) bool {
		switch n := n.(type) {
		case *ast.CallExpr:
			sel, ok := n.Fun.(*ast.SelectorExpr)
			if ok && statusWriters[sel.Sel.Name] && len(n.Args) > 0 {
				if v := strLit(n.Args[0]); v != "" {
					written[v] = true
				}
			}
			if ok && sel.Sel.Name == "setStatus" && len(n.Args) == 1 {
				if id, ok := n.Args[0].(*ast.Ident); ok && statusConsts[id.Name] != "" {
					written[statusConsts[id.Name]] = true
				}
			}
		case *ast.AssignStmt:
			for i, lhs := range n.Lhs {
				idx, ok := lhs.(*ast.IndexExpr)
				if !ok || strLit(idx.Index) != "status" || i >= len(n.Rhs) {
					continue
				}
				if id, ok := idx.X.(*ast.Ident); ok && stateMaps[id.Name] {
					if v := strLit(n.Rhs[i]); v != "" {
						written[v] = true
					}
				}
			}
		}
		return true
	})
	requireAtLeast(t, "processing statuses", written, 5)

	emitted := stringSet{}
	all := stringSet{}
	for _, s := range m.Worker.ProcessingStatuses {
		all[s.Status] = true
		if s.Emitted {
			emitted[s.Status] = true
		}
		if got := statusHoldsClaim(s.Status); got != s.HoldsClaim {
			t.Errorf("statusHoldsClaim(%q) = %v, but %s says holdsClaim %v", s.Status, got, wireFixture, s.HoldsClaim)
		}
	}
	requireSameSet(t, "allProcessingStatuses (wire_vocab.go)", vocabSet(allProcessingStatuses), all)
	if extra := written.missingFrom(all); len(extra) > 0 {
		t.Errorf("the worker writes processing statuses %v, which %s does not declare", extra, wireFixture)
	}
	if stale := emitted.missingFrom(written); len(stale) > 0 {
		t.Errorf("%s marks %v as emitted, but the worker never writes them — set emitted false", wireFixture, stale)
	}
	for _, s := range m.Worker.ProcessingStatuses {
		if !s.Emitted && written[s.Status] {
			t.Errorf("%s marks %q as never emitted, but the worker writes it — set emitted true", wireFixture, s.Status)
		}
	}
	// A status nobody declared holds the claim on both sides; the JS half
	// asserts the same of isRestingStatus.
	if !statusHoldsClaim("a-status-nobody-declared") {
		t.Error("statusHoldsClaim treats an unknown status as resting; the JS half assumes it holds the claim")
	}
}

// TestWireParityActivitiesAndItemTypes pins the Activity* and ItemType*
// constants to the manifest.
func TestWireParityActivitiesAndItemTypes(t *testing.T) {
	m := loadWireManifest(t)
	src := parseWorkerSource(t)

	activities, itemTypes := stringSet{}, stringSet{}
	src.inspect(func(_ string, n ast.Node) bool {
		spec, ok := n.(*ast.ValueSpec)
		if !ok {
			return true
		}
		for i, name := range spec.Names {
			if i >= len(spec.Values) {
				break
			}
			v := strLit(spec.Values[i])
			switch {
			case v == "":
			case strings.HasPrefix(name.Name, "ItemType"):
				itemTypes[v] = true
			case strings.HasPrefix(name.Name, "Activity"):
				activities[v] = true
			}
		}
		return true
	})
	requireAtLeast(t, "ItemType constants", itemTypes, 10)
	requireSameSet(t, "item types", itemTypes, setOf(m.Worker.ItemTypes...))
	requireAtLeast(t, "Activity constants", activities, 2)
	requireSameSet(t, "activities", activities, setOf(m.Worker.Activities...))
}

// TestWireParityPendingRequests pins the statuses and kinds a pendingItems
// entry moves through to the manifest, and holds pending_requests.go to the
// typed constants: wherever it compares, switches on or writes a status or a
// kind, a bare string literal fails here, because the comparison would still
// compile against the named type and drift silently.
func TestWireParityPendingRequests(t *testing.T) {
	m := loadWireManifest(t)
	requireSameSet(t, "allPendingStatuses (wire_vocab.go)", vocabSet(allPendingStatuses), setOf(m.Worker.PendingRequest.Statuses...))
	requireSameSet(t, "allPendingKinds (wire_vocab.go)", vocabSet(allPendingKinds), setOf(m.Worker.PendingRequest.Kinds...))

	src := parseWorkerSource(t)
	file := src.files["pending_requests.go"]
	if file == nil {
		t.Fatal("pending_requests.go is gone; point this test at where pending requests live")
	}
	isField := func(e ast.Expr) bool {
		sel, ok := e.(*ast.SelectorExpr)
		return ok && (sel.Sel.Name == "status" || sel.Sel.Name == "kind")
	}
	// constName unwraps a string(…) conversion to the constant inside it.
	constName := func(e ast.Expr) string {
		if call, ok := e.(*ast.CallExpr); ok && len(call.Args) == 1 {
			e = call.Args[0]
		}
		if id, ok := e.(*ast.Ident); ok && strings.HasPrefix(id.Name, "pending") {
			return id.Name
		}
		return ""
	}
	var literals []string
	constants := stringSet{}
	check := func(e ast.Expr) {
		if v := strLit(e); v != "" {
			literals = append(literals, strconv.Quote(v))
		} else if name := constName(e); name != "" {
			constants[name] = true
		}
	}
	ast.Inspect(file, func(n ast.Node) bool {
		switch n := n.(type) {
		case *ast.SwitchStmt:
			if isField(n.Tag) {
				for _, stmt := range n.Body.List {
					for _, e := range stmt.(*ast.CaseClause).List {
						check(e)
					}
				}
			}
		case *ast.BinaryExpr:
			if (n.Op == token.EQL || n.Op == token.NEQ) && isField(n.X) {
				check(n.Y)
			}
		case *ast.CallExpr:
			if sel, ok := n.Fun.(*ast.SelectorExpr); ok && sel.Sel.Name == "Set" && len(n.Args) == 2 && strLit(n.Args[0]) == "status" {
				check(n.Args[1])
			}
		}
		return true
	})
	if len(literals) > 0 {
		t.Errorf("pending_requests.go compares or writes pending statuses/kinds as bare strings %v — use the constants in wire_vocab.go", literals)
	}
	requireAtLeast(t, "pending status/kind constants in use", constants, 8)
}

// TestWireParityDocKeys pins the Y.Map keys the worker reads and writes.
// `item` is ConversationItem's json tags; every other group is what the source
// uses through Get/Set/Delete/Has, the yMap* readers and the metadata
// accessors. A key used without being declared fails, and so does a declared
// key nothing uses any more.
func TestWireParityDocKeys(t *testing.T) {
	m := loadWireManifest(t)
	src := parseWorkerSource(t)
	keys := m.Worker.DocKeys

	tags := stringSet{}
	ct := reflect.TypeOf(ConversationItem{})
	for i := 0; i < ct.NumField(); i++ {
		name, _, _ := strings.Cut(ct.Field(i).Tag.Get("json"), ",")
		if name != "" && name != "-" {
			tags[name] = true
		}
	}
	requireSameSet(t, "ConversationItem json tags (docKeys.item)", tags, setOf(keys.Item...))

	mapOps := setOf("Get", "Set", "Delete", "Has")
	metaOps := setOf("GetMetadata", "SetMetadata", "DeleteMetadata")
	used, meta := stringSet{}, stringSet{}
	src.inspect(func(_ string, n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok || len(call.Args) == 0 {
			return true
		}
		switch fn := call.Fun.(type) {
		case *ast.SelectorExpr:
			if v := strLit(call.Args[0]); v != "" {
				if mapOps[fn.Sel.Name] {
					used[v] = true
				}
				if metaOps[fn.Sel.Name] {
					meta[v] = true
				}
			}
		case *ast.Ident:
			if strings.HasPrefix(fn.Name, "yMap") && len(call.Args) >= 2 {
				if v := strLit(call.Args[1]); v != "" {
					used[v] = true
				}
			}
		}
		return true
	})
	requireAtLeast(t, "Y.Map keys", used, 50)
	requireAtLeast(t, "metadata keys", meta, 5)

	declared := stringSet{}
	for _, group := range [][]string{keys.Item, keys.ItemUntyped.Keys, keys.ModelConfig, keys.Metadata, keys.PendingItem} {
		for _, k := range group {
			declared[k] = true
		}
	}
	if undeclared := used.missingFrom(declared); len(undeclared) > 0 {
		t.Errorf("the worker uses Y.Map keys %v, which %s does not declare under worker.docKeys", undeclared, wireFixture)
	}
	for name, group := range map[string][]string{
		"itemUntyped": keys.ItemUntyped.Keys,
		"modelConfig": keys.ModelConfig,
		"pendingItem": keys.PendingItem,
	} {
		if stale := setOf(group...).missingFrom(used); len(stale) > 0 {
			t.Errorf("docKeys.%s declares %v, which the worker no longer uses", name, stale)
		}
	}
	usedOrMeta := stringSet{}
	for k := range used {
		usedOrMeta[k] = true
	}
	for k := range meta {
		usedOrMeta[k] = true
	}
	if extra := meta.missingFrom(setOf(keys.Metadata...)); len(extra) > 0 {
		t.Errorf("the worker uses metadata keys %v, which docKeys.metadata does not declare", extra)
	}
	if stale := setOf(keys.Metadata...).missingFrom(usedOrMeta); len(stale) > 0 {
		t.Errorf("docKeys.metadata declares %v, which the worker no longer uses", stale)
	}

	for _, f := range runProjectedFields {
		if !slices.Contains(keys.ProcessingState, f) {
			t.Errorf("runProjectedFields has %q, which docKeys.processingState does not declare", f)
		}
	}
}
