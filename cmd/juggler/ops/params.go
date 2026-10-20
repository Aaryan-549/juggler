//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"fmt"
	"reflect"
	"strconv"
	"strings"
	"sync"
)

// decodeParams reads an op's params into T, a struct whose fields say by their
// `param` tag which key each holds and how it is read. The params come from a
// model's tool call and an error goes back to it as the tool result, so the
// rules reproduce exactly what the hand-written reads did — the same words for
// a bad value, and the same tolerance of a value of the wrong type
// (TestParamContract holds the ops to that):
//
//		param:"name[,required][,max=N][,strict][,wrapped][,min=N]"
//
//	  - string with required or max: ValidateStringParam(value, name, required,
//	    max) — a wrong type, an empty required value or an over-long one is an
//	    error.
//	  - string, *string, bool, *bool, float64, *float64: set only when the value
//	    has exactly that type, and otherwise left zero (nil for a pointer, which
//	    is how a handler tells "absent" from "zero"). With strict, a value of
//	    another type is an error ("<name> must be a string|boolean|number, got
//	    <type>"); null is absent either way.
//	  - *int with min and max: ValidateIntParam(value, min, max, name), whenever
//	    the key is present — so 3, 3.0, int64(3) and "3" all read as 3.
//	  - *struct: decoded by the same rules when the value is an object, and nil
//	    otherwise.
//	  - wrapped prefixes the field's error with "invalid <name> parameter: ".
//
// Fields are read in declaration order and the first error is returned, so
// declare them in the order the op validates them. Untagged fields are left
// alone. A declaration these rules cannot apply panics on first use.
func decodeParams[T any](params map[string]any) (T, error) {
	var out T
	v := reflect.ValueOf(&out).Elem()
	if err := planFor(v.Type()).decode(v, params); err != nil {
		return out, err
	}
	return out, nil
}

type paramKind int

const (
	kindString paramKind = iota
	kindBool
	kindFloat
	kindInt
	kindNested
)

// paramField is how one struct field is read.
type paramField struct {
	index    int
	name     string
	kind     paramKind
	pointer  bool
	required bool
	strict   bool
	wrapped  bool
	max      int
	min      int
	validate bool // a string read through ValidateStringParam
	nested   *paramPlan
}

// paramPlan is how a params struct is read, worked out once per type.
type paramPlan struct {
	fields []paramField
}

var paramPlans sync.Map // reflect.Type → *paramPlan

func planFor(t reflect.Type) *paramPlan {
	if p, ok := paramPlans.Load(t); ok {
		return p.(*paramPlan)
	}
	p := buildPlan(t)
	paramPlans.Store(t, p)
	return p
}

func buildPlan(t reflect.Type) *paramPlan {
	if t.Kind() != reflect.Struct {
		panic(fmt.Sprintf("decodeParams: param struct %v is not a struct", t))
	}
	p := &paramPlan{}
	for i := range t.NumField() {
		sf := t.Field(i)
		tag, ok := sf.Tag.Lookup("param")
		if !ok {
			continue
		}
		p.fields = append(p.fields, buildField(t, i, sf, tag))
	}
	return p
}

func buildField(owner reflect.Type, i int, sf reflect.StructField, tag string) paramField {
	bad := func(format string, args ...any) {
		panic(fmt.Sprintf("decodeParams: param declaration %v.%s: %s", owner, sf.Name, fmt.Sprintf(format, args...)))
	}
	parts := strings.Split(tag, ",")
	f := paramField{index: i, name: parts[0]}
	if f.name == "" {
		bad("no param name")
	}
	hasMin, hasMax := false, false
	for _, opt := range parts[1:] {
		key, val, hasVal := strings.Cut(opt, "=")
		switch {
		case key == "required" && !hasVal:
			f.required = true
		case key == "strict" && !hasVal:
			f.strict = true
		case key == "wrapped" && !hasVal:
			f.wrapped = true
		case (key == "max" || key == "min") && hasVal:
			n, err := strconv.Atoi(val)
			if err != nil {
				bad("%s=%q is not a number", key, val)
			}
			if key == "max" {
				f.max, hasMax = n, true
			} else {
				f.min, hasMin = n, true
			}
		default:
			bad("unknown option %q", opt)
		}
	}

	ft := sf.Type
	if ft.Kind() == reflect.Pointer {
		f.pointer = true
		ft = ft.Elem()
	}
	switch ft.Kind() {
	case reflect.String:
		f.kind = kindString
		f.validate = f.required || hasMax
		if f.validate && (f.pointer || f.strict) {
			bad("required/max reads through ValidateStringParam, which neither a pointer nor strict fits")
		}
	case reflect.Bool:
		f.kind = kindBool
	case reflect.Float64:
		f.kind = kindFloat
	case reflect.Int:
		f.kind = kindInt
		if !f.pointer || !hasMin || !hasMax {
			bad("an int is a *int with min and max")
		}
	case reflect.Struct:
		if !f.pointer {
			bad("a nested struct is a pointer")
		}
		f.kind = kindNested
		f.nested = planFor(ft)
	default:
		bad("unsupported type %v", sf.Type)
	}
	if f.kind != kindString && f.required {
		bad("required applies to a string only")
	}
	if f.kind != kindString && f.kind != kindInt && hasMax {
		bad("max applies to a string or an int only")
	}
	if f.kind != kindInt && hasMin {
		bad("min applies to an int only")
	}
	if f.strict && (f.kind == kindInt || f.kind == kindNested) {
		bad("strict applies to a string, bool or number only")
	}
	return f
}

func (p *paramPlan) decode(v reflect.Value, params map[string]any) error {
	for _, f := range p.fields {
		if err := f.decode(v.Field(f.index), params); err != nil {
			if f.wrapped {
				return fmt.Errorf("invalid %s parameter: %w", f.name, err)
			}
			return err
		}
	}
	return nil
}

func (f paramField) decode(dst reflect.Value, params map[string]any) error {
	raw, present := params[f.name]
	switch f.kind {
	case kindString:
		if f.validate {
			s, err := ValidateStringParam(raw, f.name, f.required, f.max)
			if err != nil {
				return err
			}
			dst.SetString(s)
			return nil
		}
		if s, ok := raw.(string); ok {
			f.set(dst, reflect.ValueOf(s))
		} else if f.strict && raw != nil {
			return fmt.Errorf("%s must be a string, got %T", f.name, raw)
		}
	case kindBool:
		if b, ok := raw.(bool); ok {
			f.set(dst, reflect.ValueOf(b))
		} else if f.strict && raw != nil {
			return fmt.Errorf("%s must be a boolean, got %T", f.name, raw)
		}
	case kindFloat:
		if n, ok := raw.(float64); ok {
			f.set(dst, reflect.ValueOf(n))
		} else if f.strict && raw != nil {
			return fmt.Errorf("%s must be a number, got %T", f.name, raw)
		}
	case kindInt:
		if present {
			n, err := ValidateIntParam(raw, f.min, f.max, f.name)
			if err != nil {
				return err
			}
			f.set(dst, reflect.ValueOf(n))
		}
	case kindNested:
		if m, ok := raw.(map[string]any); ok {
			nv := reflect.New(dst.Type().Elem())
			if err := f.nested.decode(nv.Elem(), m); err != nil {
				return err
			}
			dst.Set(nv)
		}
	}
	return nil
}

// set stores v in dst, through a fresh pointer when the field is one.
func (f paramField) set(dst, v reflect.Value) {
	if !f.pointer {
		dst.Set(v)
		return
	}
	p := reflect.New(v.Type())
	p.Elem().Set(v)
	dst.Set(p)
}
