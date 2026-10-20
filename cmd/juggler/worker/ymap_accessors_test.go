//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"testing"

	ycrdt "github.com/skyterra/y-crdt"
)

// setAnyLikeJS stores v under key the way a decoded JS update does: as a plain
// ContentAny item, whatever its kind. YMap.Set accepts only ycrdt.Number among
// the numeric kinds and drops the rest, so a float64, float32 or int64 in a doc
// is always one a JS client wrote; this is how a test puts one there.
func setAnyLikeJS(trans *ycrdt.Transaction, m *ycrdt.YMap, key string, v any) {
	left := m.GetMap()[key]
	client := trans.Doc.ClientID
	item := ycrdt.NewItem(ycrdt.GenID(client, ycrdt.GetState(trans.Doc.Store, client)), left, ycrdt.GetItemLastID(left), nil, nil, m, key, ycrdt.NewContentAny(ycrdt.ArrayAny{v}))
	item.Integrate(trans, 0)
}

// yMapAfterRoundTrip writes fields into a Y.Map, sends the document to a second
// one the way sync and persistence do, and returns the second document's copy.
// The values that come back are the kinds a reader actually meets.
func yMapAfterRoundTrip(t *testing.T, fields map[string]any) *ycrdt.YMap {
	t.Helper()
	src := NewConversationDocument("ymap-src", "user:test")
	defer src.Destroy()
	ycrdtMu.Lock()
	src.doc.Transact(func(trans *ycrdt.Transaction) {
		m := ycrdt.NewYMap(nil)
		src.root.Set("probe", m)
		for k, v := range fields {
			setAnyLikeJS(trans, m, k, v)
		}
	}, src.txOrigin())
	ycrdtMu.Unlock()

	dst := NewConversationDocument("ymap-dst", "user:test")
	t.Cleanup(dst.Destroy)
	if err := dst.LoadFromState(src.ToState()); err != nil {
		t.Fatal(err)
	}
	m, ok := dst.root.Get("probe").(*ycrdt.YMap)
	if !ok {
		t.Fatalf("probe map did not survive the round trip: %T", dst.root.Get("probe"))
	}
	return m
}

// TestYMapInt64ReadsEveryNumericKind pins that a number reads back whatever
// kind the encoding gave it. Go writes ycrdt.Number, a varint; the JS client
// writes an integer past 31 bits as a float64, or as a float32 when that is
// exact, and a bigint decodes as int64. A reader asserting one kind silently
// misses the others.
func TestYMapInt64ReadsEveryNumericKind(t *testing.T) {
	const ms = int64(1_729_000_000_000)
	m := yMapAfterRoundTrip(t, map[string]any{
		"number":  ycrdt.Number(ms),
		"int64":   ms,
		"float64": float64(ms),
		"float32": float32(1 << 40),
		"string":  "5",
	})
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	for key, want := range map[string]int64{"number": ms, "int64": ms, "float64": ms, "float32": 1 << 40} {
		got, ok := yMapInt64(m, key)
		if !ok || got != want {
			t.Errorf("yMapInt64(%q) = %d, %v (stored as %T); want %d, true", key, got, ok, m.Get(key), want)
		}
	}
	for _, key := range []string{"string", "absent"} {
		if got, ok := yMapInt64(m, key); ok {
			t.Errorf("yMapInt64(%q) = %d, true; want ok=false", key, got)
		}
	}
}

// TestYMapAccessorsReportAbsentAndWrongTypeAlike pins the (value, ok) readers:
// a key that is missing and a key holding the wrong kind both report ok=false
// with the zero value, and a present value of the right kind reports ok=true
// even when it is the zero value.
func TestYMapAccessorsReportAbsentAndWrongTypeAlike(t *testing.T) {
	m := yMapAfterRoundTrip(t, map[string]any{
		"str": "x", "emptyStr": "", "yes": true, "no": false, "num": ycrdt.Number(1),
	})
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()

	if v, ok := yMapStringOK(m, "str"); !ok || v != "x" {
		t.Errorf(`yMapStringOK("str") = %q, %v`, v, ok)
	}
	if v, ok := yMapStringOK(m, "emptyStr"); !ok || v != "" {
		t.Errorf(`yMapStringOK("emptyStr") = %q, %v; an empty string is present`, v, ok)
	}
	if v, ok := yMapBoolOK(m, "no"); !ok || v {
		t.Errorf(`yMapBoolOK("no") = %v, %v; false is present`, v, ok)
	}
	if v, ok := yMapBoolOK(m, "yes"); !ok || !v {
		t.Errorf(`yMapBoolOK("yes") = %v, %v`, v, ok)
	}
	for _, key := range []string{"num", "absent"} {
		if v, ok := yMapStringOK(m, key); ok || v != "" {
			t.Errorf("yMapStringOK(%q) = %q, %v; want \"\", false", key, v, ok)
		}
		if v, ok := yMapBoolOK(m, key); ok || v {
			t.Errorf("yMapBoolOK(%q) = %v, %v; want false, false", key, v, ok)
		}
		if v, ok := yMapArray(m, key); ok || v != nil {
			t.Errorf("yMapArray(%q) = %v, %v; want nil, false", key, v, ok)
		}
		if v, ok := yMapMap(m, key); ok || v != nil {
			t.Errorf("yMapMap(%q) = %v, %v; want nil, false", key, v, ok)
		}
	}
}
