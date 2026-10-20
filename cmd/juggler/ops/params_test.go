//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"reflect"
	"strconv"
	"strings"
	"testing"
)

type decodeNested struct {
	Line *float64 `param:"line"`
}

// decodeFixture has one field per rule decodeParams applies.
type decodeFixture struct {
	Req        string        `param:"req,required,max=5"`
	Wrapped    string        `param:"wrapped,max=5,wrapped"`
	Strict     string        `param:"strict,strict"`
	Lenient    string        `param:"lenient"`
	Flag       bool          `param:"flag"`
	StrictFlag bool          `param:"strictFlag,strict"`
	Num        *float64      `param:"num"`
	StrictNum  float64       `param:"strictNum,strict"`
	Opt        *string       `param:"opt"`
	Depth      *int          `param:"depth,min=1,max=50"`
	Nested     *decodeNested `param:"nested"`
	Untagged   string
}

func ptr[T any](v T) *T { return &v }

func TestDecodeParams(t *testing.T) {
	cases := []struct {
		name    string
		params  map[string]any
		want    decodeFixture
		wantErr string
	}{
		{name: "a required string", params: map[string]any{"req": "ab"}, want: decodeFixture{Req: "ab"}},
		{name: "a required string missing", params: map[string]any{},
			wantErr: "req must be a string, got <nil>"},
		{name: "a required string empty", params: map[string]any{"req": ""},
			wantErr: "req cannot be empty"},
		{name: "a string past its max", params: map[string]any{"req": "abcdef"},
			wantErr: "req too long (max 5 characters)"},
		{name: "a wrapped string of the wrong type", params: map[string]any{"req": "a", "wrapped": 5},
			wantErr: "invalid wrapped parameter: wrapped must be a string if provided, got int"},
		{name: "a strict string of the wrong type", params: map[string]any{"req": "a", "strict": 5},
			wantErr: "strict must be a string, got int"},
		{name: "a strict bool of the wrong type", params: map[string]any{"req": "a", "strictFlag": "yes"},
			wantErr: "strictFlag must be a boolean, got string"},
		{name: "a strict number of the wrong type", params: map[string]any{"req": "a", "strictNum": "1"},
			wantErr: "strictNum must be a number, got string"},
		{name: "a strict field present as null is absent", params: map[string]any{"req": "a", "strict": nil, "strictFlag": nil},
			want: decodeFixture{Req: "a"}},
		{name: "lenient fields of the wrong type read as absent",
			params: map[string]any{"req": "a", "lenient": 5, "flag": "yes", "num": 3, "opt": 5, "nested": "x", "Untagged": "x"},
			want:   decodeFixture{Req: "a"}},
		{name: "every field of the right type",
			params: map[string]any{
				"req": "a", "wrapped": "w", "strict": "s", "lenient": "l", "flag": true, "strictFlag": true,
				"num": 2.5, "strictNum": 1.5, "opt": "", "nested": map[string]any{"line": 4.0},
			},
			want: decodeFixture{
				Req: "a", Wrapped: "w", Strict: "s", Lenient: "l", Flag: true, StrictFlag: true,
				Num: ptr(2.5), StrictNum: 1.5, Opt: ptr(""), Nested: &decodeNested{Line: ptr(4.0)},
			}},
		{name: "a nested field of the wrong type", params: map[string]any{"req": "a", "nested": map[string]any{"line": "4"}},
			want: decodeFixture{Req: "a", Nested: &decodeNested{}}},
		{name: "an int as any number form", params: map[string]any{"req": "a", "depth": "3"},
			want: decodeFixture{Req: "a", Depth: ptr(3)}},
		{name: "an int as an int64", params: map[string]any{"req": "a", "depth": int64(3)},
			want: decodeFixture{Req: "a", Depth: ptr(3)}},
		{name: "an int out of range", params: map[string]any{"req": "a", "depth": 0.0},
			wantErr: "depth must be between 1 and 50"},
		{name: "an int present as null", params: map[string]any{"req": "a", "depth": nil},
			wantErr: "depth must be a number"},
		{name: "the first field's error wins", params: map[string]any{"wrapped": 5, "strict": 5},
			wantErr: "req must be a string, got <nil>"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := decodeParams[decodeFixture](c.params)
			if c.wantErr != "" {
				if err == nil || err.Error() != c.wantErr {
					t.Fatalf("err = %v, want %q", err, c.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, c.want) {
				t.Errorf("decoded %+v\nwant    %+v", got, c.want)
			}
		})
	}
}

func TestDecodeParamsRefusesABadDeclaration(t *testing.T) {
	type unknownOption struct {
		X string `param:"x,sometimes"`
	}
	type unsupportedType struct {
		X []string `param:"x"`
	}
	type intWithoutRange struct {
		X *int `param:"x"`
	}
	type requiredBool struct {
		X bool `param:"x,required"`
	}
	panics := func(name string, decode func()) {
		t.Run(name, func(t *testing.T) {
			defer func() {
				r := recover()
				if r == nil {
					t.Fatal("a bad declaration decoded without complaint")
				}
				if !strings.Contains(fmtAny(r), "param") {
					t.Errorf("panic does not say it is about a param declaration: %v", r)
				}
			}()
			decode()
		})
	}
	panics("unknown option", func() { _, _ = decodeParams[unknownOption](map[string]any{}) })
	panics("unsupported type", func() { _, _ = decodeParams[unsupportedType](map[string]any{}) })
	panics("int without a range", func() { _, _ = decodeParams[intWithoutRange](map[string]any{}) })
	panics("required on a bool", func() { _, _ = decodeParams[requiredBool](map[string]any{}) })
}

// TestGetTreeDepthRangeIsMaxTreeDepth: a tag cannot name a constant, so the
// depth range is written out in getTreeParams, and this is what keeps it the
// limit the rest of the package means.
func TestGetTreeDepthRangeIsMaxTreeDepth(t *testing.T) {
	f, _ := reflect.TypeFor[getTreeParams]().FieldByName("Depth")
	want := "depth,min=1,max=" + strconv.Itoa(MaxTreeDepth)
	if got := f.Tag.Get("param"); got != want {
		t.Errorf("getTreeParams.Depth is tagged %q; MaxTreeDepth makes it %q", got, want)
	}
}

func fmtAny(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	if e, ok := v.(error); ok {
		return e.Error()
	}
	return reflect.ValueOf(v).String()
}
