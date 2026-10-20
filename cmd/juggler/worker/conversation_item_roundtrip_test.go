//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"reflect"
	"sort"
	"strings"
	"testing"

	ycrdt "github.com/skyterra/y-crdt"
)

// fillNonZero sets every field reachable from v to a non-zero value of its
// kind, so a field that a conversion drops shows up as a difference.
func fillNonZero(t *testing.T, v reflect.Value, name string) {
	t.Helper()
	if v.Type() == reflect.TypeOf(json.RawMessage(nil)) {
		v.SetBytes([]byte(`{"probe":1}`))
		return
	}
	switch v.Kind() {
	case reflect.String:
		v.SetString("v-" + name)
	case reflect.Bool:
		v.SetBool(true)
	case reflect.Int, reflect.Int64:
		v.SetInt(7)
	case reflect.Float64:
		v.SetFloat(7)
	case reflect.Struct:
		for i := 0; i < v.NumField(); i++ {
			if v.Type().Field(i).IsExported() {
				fillNonZero(t, v.Field(i), v.Type().Field(i).Name)
			}
		}
	case reflect.Slice:
		s := reflect.MakeSlice(v.Type(), 1, 1)
		fillNonZero(t, s.Index(0), name)
		v.Set(s)
	case reflect.Pointer:
		p := reflect.New(v.Type().Elem())
		fillNonZero(t, p.Elem(), name)
		v.Set(p)
	case reflect.Interface:
		v.Set(reflect.ValueOf(map[string]any{"probe": "v-" + name}))
	case reflect.Map:
		m := reflect.MakeMap(v.Type())
		val := reflect.New(v.Type().Elem()).Elem()
		fillNonZero(t, val, name)
		m.SetMapIndex(reflect.ValueOf("k"), val)
		v.Set(m)
	default:
		t.Fatalf("fillNonZero: field %s has kind %s, which this test does not know how to fill", name, v.Kind())
	}
}

// asJSONObject marshals v and decodes it back as a generic object, so two
// values compare by content rather than by struct identity or byte order.
func asJSONObject(t *testing.T, v any) map[string]any {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

// TestConversationItemRoundTripsEveryField pins that every field
// ConversationItem declares survives being written into the doc and read back.
// Items reach the doc as ConversationItem and leave it the same way, so a field
// that conversationItemToYMap writes but yMapToConversationItem never reads is
// lost on the way out, silently: the key is in the doc, and every reader that
// goes through the struct sees it as unset.
func TestConversationItemRoundTripsEveryField(t *testing.T) {
	var item ConversationItem
	fillNonZero(t, reflect.ValueOf(&item).Elem(), "item")
	// A thread's nested items are written as a Y.Array and read back by their own
	// path (TestNestedItemThatDoesNotParseIsKept); a user item carries them as
	// plain data, which this test does read back.
	item.Type = ItemTypeUser
	item.Items = json.RawMessage(`[{"type":"user","itemId":"nested"}]`)

	doc := NewConversationDocument("roundtrip", "user:test")
	defer doc.Destroy()
	doc.InsertMessage(0, item)
	got := doc.GetItems()
	if len(got) != 1 {
		t.Fatalf("read back %d items, want 1", len(got))
	}

	want, have := asJSONObject(t, item), asJSONObject(t, got[0])
	var lost []string
	for k, v := range want {
		if !reflect.DeepEqual(have[k], v) {
			lost = append(lost, k)
		}
	}
	sort.Strings(lost)
	if len(lost) > 0 {
		t.Errorf("fields that do not survive conversationItemToYMap → yMapToConversationItem: %s", strings.Join(lost, ", "))
	}
}

// nestedIDs is the itemIds of a thread map's nested items, in order.
func nestedIDs(m *ycrdt.YMap) []string {
	arr, _ := yMapArray(m, keyItems)
	if arr == nil {
		return nil
	}
	var ids []string
	for _, raw := range arr.ToArray() {
		if child, ok := raw.(*ycrdt.YMap); ok {
			ids = append(ids, yMapString(child, keyItemID))
		}
	}
	return ids
}

// TestNestedItemThatDoesNotParseIsKept pins what a thread's transcript keeps
// when one of its items does not fit ConversationItem — a field holding another
// kind, as a client or plugin can write. Each of the three paths that write a
// thread with its nested items must keep every item, the odd one included,
// rather than drop the item (or, on the live paths, the whole transcript).
func TestNestedItemThatDoesNotParseIsKept(t *testing.T) {
	thread := ConversationItem{
		Type: ItemTypeThread, ItemID: "thread", Goal: "g",
		Items: json.RawMessage(`[
			{"type":"user","itemId":"good","content":"ok"},
			{"type":"user","itemId":"odd","content":5,"pluginKey":"kept"},
			{"type":"assistant","itemId":"after","content":"still here"}
		]`),
	}
	want := []string{"good", "odd", "after"}

	paths := map[string]func(cd *ConversationDocument){
		"conversationItemToYMap": func(cd *ConversationDocument) {
			ycrdtMu.Lock()
			defer ycrdtMu.Unlock()
			cd.doc.Transact(func(_ *ycrdt.Transaction) {
				cd.ensureItems().Insert(0, ycrdt.ArrayAny{conversationItemToYMap(thread)})
			}, cd.txOrigin())
		},
		"insertMessage": func(cd *ConversationDocument) {
			cd.InsertMessage(0, thread)
		},
		"insertItemWithNested": func(cd *ConversationDocument) {
			ycrdtMu.Lock()
			defer ycrdtMu.Unlock()
			cd.doc.Transact(func(_ *ycrdt.Transaction) {
				insertItemWithNested(cd.ensureItems(), 0, thread)
			}, cd.txOrigin())
		},
	}
	for name, write := range paths {
		t.Run(name, func(t *testing.T) {
			cd := NewConversationDocument("nested-"+name, "user:test")
			defer cd.Destroy()
			write(cd)
			ycrdtMu.Lock()
			defer ycrdtMu.Unlock()
			m, ok := cd.getItems().Get(0).(*ycrdt.YMap)
			if !ok {
				t.Fatal("no thread map at index 0")
			}
			if got := nestedIDs(m); !reflect.DeepEqual(got, want) {
				t.Fatalf("nested items = %v, want %v", got, want)
			}
			arr, _ := yMapArray(m, keyItems)
			odd := arr.Get(1).(*ycrdt.YMap)
			if v, ok := yMapInt64(odd, keyContent); !ok || v != 5 {
				t.Errorf("the odd item's content = %v (%T), want the 5 it was written with", odd.Get(keyContent), odd.Get(keyContent))
			}
			if got := odd.Get("pluginKey"); got != "kept" {
				t.Errorf("the odd item's pluginKey = %v, want it kept", got)
			}
		})
	}
}
