//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package msg

import (
	"errors"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"unicode/utf8"

	"golang.org/x/text/feature/plural"
	"golang.org/x/text/language"
	"golang.org/x/text/message"
	"golang.org/x/text/number"
)

// The formatter is a port of the one in web/sdk/lib/i18n.js and follows it
// step for step: the same grammar, the same fallbacks, and the JS
// conversions — String() for a `{name}` value, Number() for a plural's —
// reproduced for Go values. What the JS takes from Intl comes here from
// golang.org/x/text, a dependency of this module already: plural categories
// from feature/plural's CLDR tables, and the `#` count from a message.Printer.
// The two sets of CLDR data are not the same release, so they can differ at
// the edges — French groups digits with U+00A0 here and U+202F in current ICU —
// which is why the parity fixture's grouped counts are English and German.

const (
	sourceLocale = "en"
	pseudoLocale = "en-XA"
)

// formatLocale is the locale whose plural rules and number format apply to a
// message rendered for locale: the pseudo-locale formats as English.
func formatLocale(locale string) string {
	if locale == pseudoLocale || locale == "" {
		return sourceLocale
	}
	return locale
}

// node is one piece of a parsed message: literal text, a `{name}`, a `#`, or
// a plural/select with its branches.
type node struct {
	kind    nodeKind
	text    string // literal text, or the argument's name
	options map[string][]node
	keys    []string // the options' selectors, each where it first appears
}

type nodeKind int

const (
	textNode nodeKind = iota
	argNode
	poundNode
	pluralNode
	selectNode
)

// parsedCache holds parsed messages by text; nil for one that does not parse.
var parsedCache sync.Map

// render formats message, falling back to the message text itself when it
// does not parse — what t() returns for an English source that will not parse.
func render(message string, params map[string]any, locale string) string {
	if out, ok := renderStrict(message, params, locale); ok {
		return out
	}
	return message
}

// renderStrict formats message, reporting false when it does not parse.
func renderStrict(message string, params map[string]any, locale string) (string, bool) {
	// The common case — no placeholders, no quoting — skips the parser.
	if !strings.ContainsAny(message, "{'") {
		return message, true
	}
	nodes, ok := parse(message)
	if !ok {
		return "", false
	}
	if params == nil {
		params = map[string]any{}
	}
	var b strings.Builder
	format(&b, nodes, params, locale, math.NaN())
	return b.String(), true
}

// format writes nodes; count is the enclosing plural's value for `#`, NaN for
// none.
func format(b *strings.Builder, nodes []node, params map[string]any, locale string, count float64) {
	for _, n := range nodes {
		switch n.kind {
		case textNode:
			b.WriteString(n.text)
		case argNode:
			if v, ok := params[n.text]; ok {
				b.WriteString(jsString(v))
			} else {
				b.WriteString("{" + n.text + "}")
			}
		case poundNode:
			if math.IsNaN(count) {
				b.WriteString("#")
			} else {
				b.WriteString(formatNumber(locale, count))
			}
		case pluralNode:
			value := math.NaN()
			if v, ok := params[n.text]; ok {
				value = jsNumber(v)
			}
			branch, ok := n.options["="+jsNumberString(value)]
			if !ok {
				branch, ok = n.options[pluralCategory(locale, value)]
			}
			if !ok {
				branch = n.options["other"]
			}
			inner := value
			if math.IsInf(value, 0) {
				inner = math.NaN()
			}
			format(b, branch, params, locale, inner)
		case selectNode:
			value := ""
			if v, ok := params[n.text]; ok && v != nil {
				value = jsString(v)
			}
			branch, ok := n.options[value]
			if !ok {
				branch = n.options["other"]
			}
			format(b, branch, params, locale, count)
		}
	}
}

// ---------------------------------------------------------------------------
// Parser — the ICU subset described in web/sdk/lib/i18n.js
// ---------------------------------------------------------------------------

// errSyntax is any malformed message but one missing an `other` branch
// (missingOtherError), the one fault a translation check names.
var errSyntax = errors.New("msg: malformed message")

// parse parses message into nodes, or reports false when it is malformed.
func parse(message string) ([]node, bool) {
	if cached, ok := parsedCache.Load(message); ok {
		nodes, _ := cached.([]node)
		return nodes, nodes != nil
	}
	nodes, err := parseStrict(message)
	if err != nil {
		nodes = nil
	}
	parsedCache.Store(message, nodes)
	return nodes, nodes != nil
}

// missingOtherError is a plural or select with no `other` branch.
type missingOtherError struct {
	kind string // "plural" or "select"
	name string
}

func (e *missingOtherError) Error() string {
	return "msg: " + e.kind + " without other"
}

// parseStrict parses message, uncached, returning why it is malformed: a
// *missingOtherError, or errSyntax for anything else.
func parseStrict(message string) ([]node, error) {
	p := &parser{text: message}
	nodes, err := p.parseNodes(false)
	if err != nil {
		return nil, err
	}
	if p.pos != len(message) {
		return nil, errSyntax // an unmatched }
	}
	if nodes == nil {
		nodes = []node{}
	}
	return nodes, nil
}

// parser is a recursive-descent parser over one message. The syntax
// characters are all ASCII, so scanning bytes is scanning characters: no byte
// of a multi-byte UTF-8 sequence can be mistaken for one.
type parser struct {
	text string
	pos  int
}

func (p *parser) peek(offset int) byte {
	if p.pos+offset < len(p.text) {
		return p.text[p.pos+offset]
	}
	return 0
}

// parseNodes parses text and placeholders up to an unmatched `}` or the end.
func (p *parser) parseNodes(inPlural bool) ([]node, error) {
	var nodes []node
	var literal strings.Builder
	flush := func() {
		if literal.Len() > 0 {
			nodes = append(nodes, node{kind: textNode, text: literal.String()})
			literal.Reset()
		}
	}
	for p.pos < len(p.text) {
		switch ch := p.text[p.pos]; {
		case ch == '\'':
			s, err := p.parseQuote(inPlural)
			if err != nil {
				return nil, err
			}
			literal.WriteString(s)
		case ch == '{':
			flush()
			n, err := p.parsePlaceholder(inPlural)
			if err != nil {
				return nil, err
			}
			nodes = append(nodes, n)
		case ch == '}':
			flush()
			return nodes, nil
		case ch == '#' && inPlural:
			flush()
			nodes = append(nodes, node{kind: poundNode})
			p.pos++
		default:
			literal.WriteByte(ch)
			p.pos++
		}
	}
	flush()
	return nodes, nil
}

// parseQuote consumes an apostrophe and whatever it quotes, returning the
// literal text.
func (p *parser) parseQuote(inPlural bool) (string, error) {
	next := p.peek(1)
	if next == '\'' {
		p.pos += 2
		return "'", nil
	}
	if next == '{' || next == '}' || (inPlural && next == '#') {
		p.pos++ // opening quote
		var quoted strings.Builder
		for p.pos < len(p.text) {
			ch := p.text[p.pos]
			p.pos++
			switch {
			case ch != '\'':
				quoted.WriteByte(ch)
			case p.peek(0) == '\'':
				quoted.WriteByte('\'')
				p.pos++
			default:
				return quoted.String(), nil
			}
		}
		return "", errSyntax // unterminated quote
	}
	p.pos++
	return "'", nil
}

// parsePlaceholder parses `{name}`, `{name, plural, …}` or `{name, select, …}`
// starting at `{`.
func (p *parser) parsePlaceholder(inPlural bool) (node, error) {
	p.pos++ // {
	name := p.match(wordPattern)
	if name == "" {
		return node{}, errSyntax
	}
	p.skipSpace()
	if p.peek(0) == '}' {
		p.pos++
		return node{kind: argNode, text: name}, nil
	}
	if err := p.expect(','); err != nil {
		return node{}, err
	}
	p.skipSpace()
	var kind nodeKind
	switch p.match(wordPattern) {
	case "plural":
		kind = pluralNode
	case "select":
		kind = selectNode
	default:
		return node{}, errSyntax
	}
	p.skipSpace()
	if err := p.expect(','); err != nil {
		return node{}, err
	}
	options := map[string][]node{}
	var keys []string
	for {
		p.skipSpace()
		if p.peek(0) == '}' {
			p.pos++
			break
		}
		key := p.match(selectorPattern)
		if key == "" {
			return node{}, errSyntax
		}
		p.skipSpace()
		if err := p.expect('{'); err != nil {
			return node{}, err
		}
		branch, err := p.parseNodes(inPlural || kind == pluralNode)
		if err != nil {
			return node{}, err
		}
		if err := p.expect('}'); err != nil {
			return node{}, err
		}
		if _, seen := options[key]; !seen {
			keys = append(keys, key)
		}
		options[key] = branch
	}
	if _, ok := options["other"]; !ok {
		kindName := "plural"
		if kind == selectNode {
			kindName = "select"
		}
		return node{}, &missingOtherError{kind: kindName, name: name}
	}
	return node{kind: kind, text: name, options: options, keys: keys}, nil
}

var (
	wordPattern     = regexp.MustCompile(`^[A-Za-z0-9_]+`)
	selectorPattern = regexp.MustCompile(`^(=\d+|[A-Za-z0-9_-]+)`)
)

// match consumes and returns pattern's match at the current position, or "".
func (p *parser) match(pattern *regexp.Regexp) string {
	m := pattern.FindString(p.text[p.pos:])
	p.pos += len(m)
	return m
}

// skipSpace skips what JS's \s matches.
func (p *parser) skipSpace() {
	for p.pos < len(p.text) {
		r, size := utf8.DecodeRuneInString(p.text[p.pos:])
		if !isJSSpace(r) {
			return
		}
		p.pos += size
	}
}

func (p *parser) expect(ch byte) error {
	if p.peek(0) != ch {
		return errSyntax
	}
	p.pos++
	return nil
}

// isJSSpace reports whether JS's \s matches r: WhiteSpace and LineTerminator
// in ECMAScript, which is not quite unicode.IsSpace (no U+0085; U+FEFF).
func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}

// ---------------------------------------------------------------------------
// JS value conversions
// ---------------------------------------------------------------------------

// jsString is JS's String(v) for the JSON form of a Go value, so a parameter
// reads the same rendered here as in the viewer. A value with no JSON scalar
// form — a struct, a slice — renders with fmt.Sprint, which the viewer cannot
// match; params should be scalars.
func jsString(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case string:
		return x
	case bool:
		return strconv.FormatBool(x)
	case int:
		return strconv.Itoa(x)
	case int8, int16, int32, int64:
		return fmt.Sprint(x)
	case uint, uint8, uint16, uint32, uint64, uintptr:
		return fmt.Sprint(x)
	case float32:
		return jsNumberString(float64(x))
	case float64:
		return jsNumberString(x)
	case error:
		return x.Error()
	case fmt.Stringer:
		return x.String()
	}
	return fmt.Sprint(v)
}

// jsNumber is JS's Number(v): numbers as themselves, booleans 1 and 0, null 0,
// strings parsed as JS parses them, anything else NaN.
func jsNumber(v any) float64 {
	switch x := v.(type) {
	case nil:
		return 0
	case bool:
		if x {
			return 1
		}
		return 0
	case int:
		return float64(x)
	case int8:
		return float64(x)
	case int16:
		return float64(x)
	case int32:
		return float64(x)
	case int64:
		return float64(x)
	case uint:
		return float64(x)
	case uint8:
		return float64(x)
	case uint16:
		return float64(x)
	case uint32:
		return float64(x)
	case uint64:
		return float64(x)
	case float32:
		return float64(x)
	case float64:
		return x
	case string:
		return jsStringToNumber(x)
	}
	return math.NaN()
}

var jsDecimal = regexp.MustCompile(`^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$`)

// jsStringToNumber is JS's StringToNumber: surrounding space trimmed, empty is
// 0, decimal literals, Infinity, and unsigned 0x/0o/0b integers.
func jsStringToNumber(s string) float64 {
	s = strings.TrimFunc(s, isJSSpace)
	switch s {
	case "":
		return 0
	case "Infinity", "+Infinity":
		return math.Inf(1)
	case "-Infinity":
		return math.Inf(-1)
	}
	if len(s) > 2 && s[0] == '0' {
		base := 0
		switch s[1] {
		case 'x', 'X':
			base = 16
		case 'o', 'O':
			base = 8
		case 'b', 'B':
			base = 2
		}
		if base != 0 {
			if n, err := strconv.ParseUint(s[2:], base, 64); err == nil {
				return float64(n)
			}
			return math.NaN()
		}
	}
	if !jsDecimal.MatchString(s) {
		return math.NaN()
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil && !math.IsInf(f, 0) {
		return math.NaN()
	}
	return f
}

// jsNumberString is JS's Number.prototype.toString(): the shortest digits that
// round-trip, fixed notation from 1e-7 up to 1e21, an exponent outside it.
func jsNumberString(f float64) string {
	switch {
	case math.IsNaN(f):
		return "NaN"
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	case f == 0:
		return "0"
	}
	sign := ""
	if f < 0 {
		sign = "-"
		f = -f
	}
	// d.ddde±x: the digits and the decimal exponent.
	e := strconv.FormatFloat(f, 'e', -1, 64)
	mantissa, exp, _ := strings.Cut(e, "e")
	digits := strings.Replace(mantissa, ".", "", 1)
	x, _ := strconv.Atoi(exp)
	n := x + 1 // where the decimal point falls, counted from the left of digits
	k := len(digits)
	switch {
	case k <= n && n <= 21:
		return sign + digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		return sign + digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		return sign + "0." + strings.Repeat("0", -n) + digits
	}
	expSign := "+"
	if n-1 < 0 {
		expSign = "-"
	}
	frac := ""
	if k > 1 {
		frac = "." + digits[1:]
	}
	return sign + digits[:1] + frac + "e" + expSign + strconv.Itoa(abs(n-1))
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

// ---------------------------------------------------------------------------
// Locale data
// ---------------------------------------------------------------------------

// pluralCategory is the CLDR cardinal category of value in locale, as
// Intl.PluralRules(locale).select(value) gives it: the operands are taken from
// the value rounded to three fraction digits, PluralRules' default. "other"
// for a value that is not finite or a locale that does not parse.
func pluralCategory(locale string, value float64) string {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return "other"
	}
	tag, err := language.Parse(locale)
	if err != nil {
		return "other"
	}
	// Operands from the absolute value, at most three fraction digits, trailing
	// zeros dropped (so v = w and f = t). An integer part too large for the
	// rules' modular arithmetic is reduced modulo 10,000,000, which
	// MatchPlural permits.
	fixed := strings.TrimRight(strings.TrimRight(strconv.FormatFloat(math.Abs(value), 'f', 3, 64), "0"), ".")
	whole, fraction, _ := strings.Cut(fixed, ".")
	if len(whole) > 7 {
		whole = whole[len(whole)-7:]
	}
	i, _ := strconv.Atoi(whole)
	f, _ := strconv.Atoi("0" + fraction)
	v := len(fraction)
	switch plural.Cardinal.MatchPlural(tag, i, v, v, f, f) {
	case plural.Zero:
		return "zero"
	case plural.One:
		return "one"
	case plural.Two:
		return "two"
	case plural.Few:
		return "few"
	case plural.Many:
		return "many"
	}
	return "other"
}

// formatNumber is formatNumber(value) in web/sdk/lib/i18n.js: grouped, up to
// three fraction digits, in locale's digits and separators — English for a
// locale that does not parse.
func formatNumber(locale string, value float64) string {
	tag, err := language.Parse(locale)
	if err != nil {
		tag = language.English
	}
	return message.NewPrinter(tag).Sprint(number.Decimal(value, number.MaxFractionDigits(3)))
}
