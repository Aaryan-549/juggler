//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package i18nextract

import (
	"fmt"
	"regexp"
)

// Each rule below stands for the AST rule scripts/i18n applies with espree,
// over the tokens that make up the node it looks for.

var (
	// mentionsI18n and mentionsManifest pick the files worth parsing.
	mentionsI18n     = regexp.MustCompile(`\bi18n\b`)
	mentionsManifest = regexp.MustCompile(`\bMANIFEST\b`)
	// i18nSource matches the import sources that provide t().
	i18nSource = regexp.MustCompile(`(^|/)i18n\.js$|^juggler/i18n$`)
)

// messageFunctions are the imports whose literal first argument is a message.
var messageFunctions = map[string]bool{"t": true, "markForTranslation": true}

// manifestFields are the MANIFEST fields that hold text the UI shows.
var manifestFields = map[string]bool{"name": true, "description": true, "addLabel": true, "eyebrow": true, "setupLabel": true}

// contextSeparator joins a context to its source in a catalogue key.
const contextSeparator = "\u0004"

// messageKey is messageKey in web/sdk/lib/i18n.js.
func messageKey(source, context string) string {
	if context == "" {
		return source
	}
	return context + contextSeparator + source
}

// module is one tokenized module, with each bracket's partner.
type module struct {
	toks  []token
	match []int // for an opening bracket its closer, and the reverse; -1 otherwise
}

func (m *module) is(i int, kind tokKind, value string) bool {
	return i >= 0 && i < len(m.toks) && m.toks[i].kind == kind && m.toks[i].value == value
}

func (m *module) punct(i int, value string) bool { return m.is(i, tkPunct, value) }

func (m *module) ident(i int, value string) bool { return m.is(i, tkIdent, value) }

// opens reports whether token i opens a group: a bracket or a template head.
func (m *module) opens(i int) bool {
	t := m.toks[i]
	return t.kind == tkTemplateHead || t.kind == tkPunct && (t.value == "(" || t.value == "[" || t.value == "{")
}

// closes reports whether token i closes a group.
func (m *module) closes(i int) bool {
	t := m.toks[i]
	return t.kind == tkTemplateTail || t.kind == tkPunct && (t.value == ")" || t.value == "]" || t.value == "}")
}

// pairBrackets fills match, failing on brackets that do not pair.
func (m *module) pairBrackets() error {
	m.match = make([]int, len(m.toks))
	var stack []int
	for i := range m.toks {
		m.match[i] = -1
		switch {
		case m.opens(i):
			stack = append(stack, i)
		case m.closes(i):
			if len(stack) == 0 {
				return fmt.Errorf("line %d: unmatched %q", m.toks[i].line, m.toks[i].value)
			}
			j := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			m.match[i], m.match[j] = j, i
		}
	}
	if len(stack) > 0 {
		return fmt.Errorf("line %d: unclosed bracket", m.toks[stack[len(stack)-1]].line)
	}
	return nil
}

// span is the token range [a, b).
type span struct{ a, b int }

// group reports whether s is exactly one group opened by open.
func (m *module) group(s span, open string) bool {
	return s.b-s.a >= 2 && m.punct(s.a, open) && m.match[s.a] == s.b-1
}

// unparen strips parentheses wrapping all of s, as the AST drops them.
func (m *module) unparen(s span) span {
	for m.group(s, "(") {
		s = span{s.a + 1, s.b - 1}
	}
	return s
}

// split divides s at its top-level commas, dropping the empty piece a
// trailing comma leaves.
func (m *module) split(s span) []span {
	var out []span
	start := s.a
	for i := s.a; i < s.b; i++ {
		switch {
		case m.opens(i):
			i = m.match[i]
		case m.punct(i, ","):
			out = append(out, span{start, i})
			start = i + 1
		}
	}
	if start < s.b {
		out = append(out, span{start, s.b})
	}
	return out
}

// staticString is staticString in scripts/i18n: the value of a string
// literal, a template with no substitutions, or a `+` of those.
func (m *module) staticString(s span) (string, bool) {
	s = m.unparen(s)
	if s.a >= s.b {
		return "", false
	}
	value := ""
	expectOperand := true
	for i := s.a; i < s.b; i++ {
		t := m.toks[i]
		if !expectOperand {
			if !m.punct(i, "+") {
				return "", false
			}
			expectOperand = true
			continue
		}
		switch {
		case t.kind == tkString || t.kind == tkTemplate:
			value += t.value
		case m.punct(i, "("):
			inner, ok := m.staticString(span{i + 1, m.match[i]})
			if !ok {
				return "", false
			}
			value += inner
			i = m.match[i]
		default:
			return "", false
		}
		expectOperand = false
	}
	return value, !expectOperand
}

// continues reports whether token i, starting a line, carries on the
// expression before it rather than starting a statement.
func (m *module) continues(i int) bool {
	t := m.toks[i]
	switch t.kind {
	case tkTemplate, tkTemplateHead:
		return true
	case tkIdent:
		return t.value == "in" || t.value == "instanceof"
	case tkPunct:
		switch t.value {
		case "++", "--", "{", "}", ")", "]", ";", "!", "~", "@":
			return false
		}
		return true
	}
	return false
}

// exprEnd is where an initializer starting at i ends: a top-level `,` or `;`,
// the bracket closing the group it sits in, or a line break where a
// semicolon would be inserted.
func (m *module) exprEnd(i int) int {
	for k := i; k < len(m.toks); k++ {
		if k > i && m.toks[k].nl && !m.continues(k) {
			return k
		}
		switch {
		case m.opens(k):
			k = m.match[k]
		case m.closes(k) || m.punct(k, ",") || m.punct(k, ";"):
			return k
		}
	}
	return len(m.toks)
}

// isDeclarator reports whether the identifier at i is the binding of a
// variable declarator: right after const/let/var, or after a comma in that
// declaration's list.
func (m *module) isDeclarator(i int) bool {
	k := i - 1
	if k < 0 {
		return false
	}
	if m.ident(k, "const") || m.ident(k, "let") || m.ident(k, "var") {
		return true
	}
	if !m.punct(k, ",") {
		return false
	}
	for k--; k >= 0; k-- {
		switch {
		case m.closes(k):
			k = m.match[k]
		case m.opens(k) || m.punct(k, ";"):
			return false
		case m.ident(k, "const") || m.ident(k, "let") || m.ident(k, "var"):
			return true
		}
	}
	return false
}

// property is one member of an object literal.
type property struct {
	spread   bool // ...x
	computed bool // [key]
	key      string
	named    bool // the key is an identifier or a string, so key holds it
	value    span // the value after `:`
	hasValue bool // a `key: value` member, not a method or shorthand
}

// properties reads the members of the object literal whose braces are s.
func (m *module) properties(s span) []property {
	var out []property
	for _, p := range m.split(span{s.a + 1, s.b - 1}) {
		out = append(out, m.property(p))
	}
	return out
}

func (m *module) property(s span) property {
	i := s.a
	if m.punct(i, "...") {
		return property{spread: true}
	}
	// A modifier is a modifier only when a key follows it.
	for i < s.b {
		if m.punct(i, "*") {
			i++
			continue
		}
		t := m.toks[i]
		if t.kind == tkIdent && (t.value == "get" || t.value == "set" || t.value == "async") && i+1 < s.b &&
			!m.punct(i+1, ":") && !m.punct(i+1, "(") && !m.punct(i+1, ",") && !m.punct(i+1, "=") {
			i++
			continue
		}
		break
	}
	if i >= s.b || m.punct(i, "[") {
		return property{computed: true}
	}
	p := property{}
	switch t := m.toks[i]; t.kind {
	case tkIdent, tkString:
		p.key, p.named = t.value, true
	}
	if m.punct(i+1, ":") && i+1 < s.b {
		p.value, p.hasValue = span{i + 2, s.b}, true
	}
	return p
}

// extractJS adds one module's messages to messages, returning its problems.
// where names the file in a problem.
func extractJS(src []byte, where string, messages map[string]string) []string {
	text := string(src)
	hasI18n := mentionsI18n.MatchString(text)
	if !hasI18n && !mentionsManifest.MatchString(text) {
		return nil
	}
	toks, err := tokenize(text)
	m := &module{toks: toks}
	if err == nil {
		err = m.pairBrackets()
	}
	if err != nil {
		return []string{fmt.Sprintf("%s: does not parse: %v", where, err)}
	}
	for _, source := range m.capabilityMessages() {
		messages[source] = source
	}
	if !hasI18n {
		return nil
	}
	names := m.messageNames()
	if len(names) == 0 {
		return nil
	}
	return m.calls(names, where, messages)
}

// capabilityMessages is capabilityMessages in scripts/i18n: the text fields of
// each `static MANIFEST = {…}` class field.
func (m *module) capabilityMessages() []string {
	var out []string
	add := func(s span) {
		if v, ok := m.staticString(s); ok && hasLetter.MatchString(v) {
			out = append(out, v)
		}
	}
	for i := 0; i+3 < len(m.toks); i++ {
		if !m.ident(i, "static") || !m.ident(i+1, "MANIFEST") || !m.punct(i+2, "=") {
			continue
		}
		value := m.unparen(span{i + 3, m.exprEnd(i + 3)})
		if !m.group(value, "{") {
			continue
		}
		for _, p := range m.properties(value) {
			if p.spread || p.computed || !p.named || !p.hasValue {
				continue
			}
			if p.key == "recommendations" {
				if advice := m.unparen(p.value); m.group(advice, "{") {
					for _, a := range m.properties(advice) {
						if a.spread || a.computed || !a.named || !a.hasValue {
							continue
						}
						switch a.key {
						case "bestFor", "avoidFor":
							add(a.value)
						case "notes":
							if notes := m.unparen(a.value); m.group(notes, "[") {
								for _, note := range m.split(span{notes.a + 1, notes.b - 1}) {
									add(note)
								}
							}
						}
					}
					continue
				}
			}
			if manifestFields[p.key] {
				add(p.value)
			}
		}
	}
	return out
}

// messageNames are the local names bound to a message function: by an import
// from an i18n module, or by `const t = translator(…)` with translator so
// imported.
func (m *module) messageNames() map[string]bool {
	names := map[string]bool{}
	translators := map[string]bool{}
	for i := 0; i < len(m.toks); i++ {
		if m.opens(i) {
			i = m.match[i] // declarations are only at the top level
			continue
		}
		if !m.ident(i, "import") || m.punct(i+1, "(") || m.punct(i+1, ".") || m.punct(i-1, ".") {
			continue
		}
		j := i + 1
		var specs []span
		for j < len(m.toks) && !m.ident(j, "from") && !m.punct(j, ";") && m.toks[j].kind != tkString {
			if m.punct(j, "{") {
				specs = m.split(span{j + 1, m.match[j]})
				j = m.match[j]
			}
			j++
		}
		if !m.ident(j, "from") || j+1 >= len(m.toks) || m.toks[j+1].kind != tkString || !i18nSource.MatchString(m.toks[j+1].value) {
			continue
		}
		for _, s := range specs {
			if m.toks[s.a].kind != tkIdent {
				continue // a string import name has no .name to match
			}
			imported, local := m.toks[s.a].value, m.toks[s.a].value
			if s.b-s.a == 3 && m.ident(s.a+1, "as") {
				local = m.toks[s.a+2].value
			}
			if messageFunctions[imported] {
				names[local] = true
			}
			if imported == "translator" {
				translators[local] = true
			}
		}
	}
	if len(translators) > 0 {
		for i := 0; i+2 < len(m.toks); i++ {
			if m.toks[i].kind != tkIdent || !m.punct(i+1, "=") || !m.isDeclarator(i) {
				continue
			}
			init := m.unparen(span{i + 2, m.exprEnd(i + 2)})
			if init.b-init.a >= 3 && m.toks[init.a].kind == tkIdent && translators[m.toks[init.a].value] &&
				m.punct(init.a+1, "(") && m.match[init.a+1] == init.b-1 {
				names[m.toks[i].value] = true
			}
		}
	}
	return names
}

// calls adds the message of each call to a name in names: a call whose callee
// is that bare identifier, with a static first argument.
func (m *module) calls(names map[string]bool, where string, messages map[string]string) []string {
	var problems []string
	for i, t := range m.toks {
		if t.kind != tkIdent || !names[t.value] {
			continue
		}
		if m.punct(i-1, ".") || m.punct(i-1, "?.") || m.ident(i-1, "new") || m.ident(i-1, "function") ||
			m.punct(i-1, "*") && m.ident(i-2, "function") {
			continue
		}
		open := i + 1
		if m.punct(open, "?.") {
			open++
		}
		if !m.punct(open, "(") {
			continue
		}
		closer := m.match[open]
		if m.punct(closer+1, "{") {
			continue // a method definition, not a call
		}
		args := m.split(span{open + 1, closer})
		if len(args) == 0 {
			continue
		}
		source, ok := m.staticString(args[0])
		if !ok {
			continue // a t() of a variable translates a message marked elsewhere
		}
		at := fmt.Sprintf("%s:%d", where, t.line)
		context := ""
		if len(args) > 2 {
			opts := m.unparen(args[2])
			switch {
			case opts.b-opts.a == 1 && m.ident(opts.a, "undefined"):
			case m.group(opts, "{"):
				props := m.properties(opts)
				unreadable := false
				for _, p := range props {
					unreadable = unreadable || p.spread || p.computed
				}
				if unreadable {
					problems = append(problems, at+": t() options must be an inline object literal with plain keys, so a context in them is seen")
					continue
				}
				bad := false
				for _, p := range props {
					if !p.named || p.key != "context" {
						continue
					}
					if !p.hasValue {
						bad = true
					} else if context, ok = m.staticString(p.value); !ok {
						bad = true
					}
					break
				}
				if bad {
					problems = append(problems, at+": t() context must be a literal")
					continue
				}
			default:
				problems = append(problems, at+": t() options must be an inline object literal with plain keys, so a context in them is seen")
				continue
			}
		}
		messages[messageKey(source, context)] = source
	}
	return problems
}
