//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package i18nextract

import (
	"fmt"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"
)

// The tokenizer reads an ES module as far as extraction needs: comments and
// whitespace dropped, string and template literals decoded as JS reads them,
// and regular expressions told apart from division by the token before them.
// It does not check the grammar; extraction then matches token shapes that
// stand for the AST nodes scripts/i18n looks for.

type tokKind int

const (
	tkIdent          tokKind = iota // an identifier or keyword
	tkPrivate                       // #name
	tkNumber                        // a numeric literal
	tkString                        // a string literal; value decoded
	tkTemplate                      // a template with no substitutions; value cooked
	tkTemplateHead                  // `…${ — opens a template with substitutions
	tkTemplateMiddle                // }…${
	tkTemplateTail                  // }…` — closes it
	tkRegex                         // a regular expression literal
	tkPunct                         // a punctuator; value is its text
)

type token struct {
	kind  tokKind
	value string
	line  int
	// nl is set when a line terminator precedes the token: where automatic
	// semicolon insertion can end a statement.
	nl bool
	// ctrl is set on a `)` closing an if/while/for/with head, after which a `/`
	// starts a regular expression.
	ctrl bool
}

// punctuators, longest first so the first match is the longest.
var punctuators = []string{
	">>>=", "...", "===", "!==", "**=", "<<=", ">>=", ">>>", "&&=", "||=", "??=",
	"=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--", "+=", "-=", "*=", "/=", "%=",
	"&=", "|=", "^=", "**", "<<", ">>",
	"{", "}", "(", ")", "[", "]", ";", ",", "<", ">", "+", "-", "*", "/", "%", "&", "|", "^",
	"!", "~", "?", ":", "=", ".", "@",
}

// regexAfterKeyword are the keywords after which a `/` starts a regular
// expression rather than dividing.
var regexAfterKeyword = map[string]bool{
	"return": true, "typeof": true, "instanceof": true, "in": true, "of": true, "new": true,
	"delete": true, "void": true, "throw": true, "case": true, "do": true, "else": true,
	"yield": true, "await": true,
}

type lexer struct {
	src    string
	pos    int
	line   int
	nl     bool
	toks   []token
	braces []bool // per open `{` or `${`: true for a template substitution
	parens []bool // per open `(`: whether it is an if/while/for/with head
}

// tokenize splits a module into tokens, or reports why it cannot.
func tokenize(src string) ([]token, error) {
	lx := &lexer{src: src, line: 1}
	if strings.HasPrefix(src, "#!") {
		lx.skipLine()
	}
	for {
		if err := lx.skipSpace(); err != nil {
			return nil, err
		}
		if lx.pos >= len(lx.src) {
			return lx.toks, nil
		}
		if err := lx.next(); err != nil {
			return nil, fmt.Errorf("line %d: %w", lx.line, err)
		}
	}
}

func (lx *lexer) peekRune(off int) (rune, int) {
	if lx.pos+off >= len(lx.src) {
		return -1, 0
	}
	return utf8.DecodeRuneInString(lx.src[lx.pos+off:])
}

// lineTerminator reports the length of a line terminator at i, or 0.
func lineTerminator(s string, i int) int {
	if i >= len(s) {
		return 0
	}
	switch s[i] {
	case '\n':
		return 1
	case '\r':
		if i+1 < len(s) && s[i+1] == '\n' {
			return 2
		}
		return 1
	}
	if strings.HasPrefix(s[i:], "\u2028") || strings.HasPrefix(s[i:], "\u2029") {
		return 3
	}
	return 0
}

func isJSWhitespace(r rune) bool {
	switch r {
	case '\t', '\v', '\f', ' ', 0xA0, 0xFEFF:
		return true
	}
	return unicode.Is(unicode.Zs, r)
}

func (lx *lexer) skipLine() {
	for lx.pos < len(lx.src) && lineTerminator(lx.src, lx.pos) == 0 {
		lx.pos++
	}
}

// skipSpace skips whitespace, line terminators and comments, noting any line
// terminator among them.
func (lx *lexer) skipSpace() error {
	for lx.pos < len(lx.src) {
		if n := lineTerminator(lx.src, lx.pos); n > 0 {
			lx.pos += n
			lx.line++
			lx.nl = true
			continue
		}
		if strings.HasPrefix(lx.src[lx.pos:], "//") {
			lx.skipLine()
			continue
		}
		if strings.HasPrefix(lx.src[lx.pos:], "/*") {
			end := strings.Index(lx.src[lx.pos+2:], "*/")
			if end < 0 {
				return fmt.Errorf("line %d: unterminated comment", lx.line)
			}
			body := lx.src[lx.pos+2 : lx.pos+2+end]
			if lines := countLines(body); lines > 0 {
				lx.line += lines
				lx.nl = true
			}
			lx.pos += end + 4
			continue
		}
		r, size := lx.peekRune(0)
		if !isJSWhitespace(r) {
			return nil
		}
		lx.pos += size
	}
	return nil
}

// countLines counts the line terminators in s.
func countLines(s string) int {
	n := 0
	for i := 0; i < len(s); {
		if l := lineTerminator(s, i); l > 0 {
			n++
			i += l
		} else {
			i++
		}
	}
	return n
}

func (lx *lexer) emit(kind tokKind, value string, line int) {
	lx.toks = append(lx.toks, token{kind: kind, value: value, line: line, nl: lx.nl})
	lx.nl = false
}

func isIDStart(r rune) bool {
	return r == '$' || r == '_' || unicode.IsLetter(r) || unicode.Is(unicode.Nl, r)
}

func isIDPart(r rune) bool {
	return isIDStart(r) || unicode.IsDigit(r) || unicode.In(r, unicode.Mn, unicode.Mc, unicode.Nd, unicode.Pc) ||
		r == 0x200C || r == 0x200D
}

func (lx *lexer) next() error {
	line := lx.line
	c := lx.src[lx.pos]
	r, _ := lx.peekRune(0)
	switch {
	case c == '"' || c == '\'':
		s, err := lx.readString(c)
		if err != nil {
			return err
		}
		lx.emit(tkString, s, line)
	case c == '`':
		lx.pos++
		return lx.readTemplate(true, line)
	case c == '}' && len(lx.braces) > 0 && lx.braces[len(lx.braces)-1]:
		lx.braces = lx.braces[:len(lx.braces)-1]
		lx.pos++
		return lx.readTemplate(false, line)
	case c >= '0' && c <= '9' || c == '.' && lx.pos+1 < len(lx.src) && lx.src[lx.pos+1] >= '0' && lx.src[lx.pos+1] <= '9':
		lx.emit(tkNumber, lx.readNumber(), line)
	case c == '#':
		lx.pos++
		name, err := lx.readIdent()
		if err != nil || name == "" {
			return fmt.Errorf("unexpected #")
		}
		lx.emit(tkPrivate, name, line)
	case isIDStart(r) || c == '\\':
		name, err := lx.readIdent()
		if err != nil {
			return err
		}
		if name == "" {
			return fmt.Errorf("unexpected character %q", r)
		}
		lx.emit(tkIdent, name, line)
	case c == '/' && lx.regexAllowed():
		re, err := lx.readRegex()
		if err != nil {
			return err
		}
		lx.emit(tkRegex, re, line)
	default:
		return lx.readPunct(line)
	}
	return nil
}

func (lx *lexer) readPunct(line int) error {
	rest := lx.src[lx.pos:]
	for _, p := range punctuators {
		if !strings.HasPrefix(rest, p) {
			continue
		}
		// `?.` before a digit is `?` then a number: a ? .5 : b.
		if p == "?." && len(rest) > 2 && rest[2] >= '0' && rest[2] <= '9' {
			continue
		}
		lx.pos += len(p)
		switch p {
		case "{":
			lx.braces = append(lx.braces, false)
		case "}":
			if len(lx.braces) > 0 {
				lx.braces = lx.braces[:len(lx.braces)-1]
			}
		case "(":
			lx.parens = append(lx.parens, lx.prevIsKeyword("if", "while", "for", "with"))
		}
		lx.emit(tkPunct, p, line)
		if p == ")" && len(lx.parens) > 0 {
			lx.toks[len(lx.toks)-1].ctrl = lx.parens[len(lx.parens)-1]
			lx.parens = lx.parens[:len(lx.parens)-1]
		}
		return nil
	}
	r, _ := lx.peekRune(0)
	return fmt.Errorf("unexpected character %q", r)
}

// prevIsKeyword reports whether the last token is one of the given words.
func (lx *lexer) prevIsKeyword(words ...string) bool {
	if len(lx.toks) == 0 {
		return false
	}
	prev := lx.toks[len(lx.toks)-1]
	if prev.kind != tkIdent {
		return false
	}
	for _, w := range words {
		if prev.value == w {
			return true
		}
	}
	return false
}

// regexAllowed reports whether a `/` here starts a regular expression: where
// an expression may begin, judged by the token before it.
func (lx *lexer) regexAllowed() bool {
	if len(lx.toks) == 0 {
		return true
	}
	prev := lx.toks[len(lx.toks)-1]
	switch prev.kind {
	case tkIdent:
		return regexAfterKeyword[prev.value]
	case tkPunct:
		switch prev.value {
		case ")":
			return prev.ctrl
		case "]", "++", "--":
			return false
		}
		return true
	case tkTemplateHead, tkTemplateMiddle:
		return true
	}
	return false
}

func (lx *lexer) readRegex() (string, error) {
	start := lx.pos
	lx.pos++ // opening /
	inClass := false
	for {
		if lx.pos >= len(lx.src) || lineTerminator(lx.src, lx.pos) > 0 {
			return "", fmt.Errorf("unterminated regular expression")
		}
		c := lx.src[lx.pos]
		switch {
		case c == '\\':
			lx.pos++
			if lx.pos >= len(lx.src) || lineTerminator(lx.src, lx.pos) > 0 {
				return "", fmt.Errorf("unterminated regular expression")
			}
			_, size := utf8.DecodeRuneInString(lx.src[lx.pos:])
			lx.pos += size
			continue
		case c == '[':
			inClass = true
		case c == ']':
			inClass = false
		case c == '/' && !inClass:
			lx.pos++
			for lx.pos < len(lx.src) {
				r, size := utf8.DecodeRuneInString(lx.src[lx.pos:])
				if !isIDPart(r) {
					break
				}
				lx.pos += size
			}
			return lx.src[start:lx.pos], nil
		}
		lx.pos++
	}
}

func (lx *lexer) readNumber() string {
	start := lx.pos
	s := lx.src
	isDigitish := func(c byte) bool { return c >= '0' && c <= '9' || c == '_' }
	if s[lx.pos] == '0' && lx.pos+1 < len(s) && strings.ContainsRune("xXoObB", rune(s[lx.pos+1])) {
		lx.pos += 2
		for lx.pos < len(s) && (isDigitish(s[lx.pos]) || strings.ContainsRune("abcdefABCDEF", rune(s[lx.pos]))) {
			lx.pos++
		}
	} else {
		for lx.pos < len(s) && isDigitish(s[lx.pos]) {
			lx.pos++
		}
		if lx.pos < len(s) && s[lx.pos] == '.' {
			lx.pos++
			for lx.pos < len(s) && isDigitish(s[lx.pos]) {
				lx.pos++
			}
		}
		if lx.pos < len(s) && (s[lx.pos] == 'e' || s[lx.pos] == 'E') {
			lx.pos++
			if lx.pos < len(s) && (s[lx.pos] == '+' || s[lx.pos] == '-') {
				lx.pos++
			}
			for lx.pos < len(s) && isDigitish(s[lx.pos]) {
				lx.pos++
			}
		}
	}
	if lx.pos < len(s) && s[lx.pos] == 'n' {
		lx.pos++
	}
	return s[start:lx.pos]
}

// readIdent reads an identifier, decoding \u escapes in it; "" if none starts here.
func (lx *lexer) readIdent() (string, error) {
	var b strings.Builder
	first := true
	for lx.pos < len(lx.src) {
		r, size := lx.peekRune(0)
		if r == '\\' {
			if lx.pos+1 >= len(lx.src) || lx.src[lx.pos+1] != 'u' {
				return "", fmt.Errorf("bad escape in identifier")
			}
			lx.pos += 2
			cp, err := lx.readUnicodeEscape()
			if err != nil {
				return "", err
			}
			b.WriteRune(cp)
			first = false
			continue
		}
		if first && !isIDStart(r) || !first && !isIDPart(r) {
			break
		}
		b.WriteRune(r)
		lx.pos += size
		first = false
	}
	return b.String(), nil
}

// readUnicodeEscape reads the part of a \u escape after the u: XXXX or {X…}.
func (lx *lexer) readUnicodeEscape() (rune, error) {
	s := lx.src
	if lx.pos < len(s) && s[lx.pos] == '{' {
		end := strings.IndexByte(s[lx.pos:], '}')
		if end < 0 {
			return 0, fmt.Errorf("bad \\u{} escape")
		}
		n, err := strconv.ParseUint(s[lx.pos+1:lx.pos+end], 16, 32)
		if err != nil || n > 0x10FFFF {
			return 0, fmt.Errorf("bad \\u{} escape")
		}
		lx.pos += end + 1
		return rune(n), nil
	}
	if lx.pos+4 > len(s) {
		return 0, fmt.Errorf("bad \\u escape")
	}
	n, err := strconv.ParseUint(s[lx.pos:lx.pos+4], 16, 32)
	if err != nil {
		return 0, fmt.Errorf("bad \\u escape")
	}
	lx.pos += 4
	return rune(n), nil
}

// readEscape decodes the escape whose backslash is at lx.pos into units, as
// UTF-16 code units so surrogate pairs written as two escapes join.
func (lx *lexer) readEscape(units []uint16) ([]uint16, error) {
	lx.pos++ // backslash
	if lx.pos >= len(lx.src) {
		return nil, fmt.Errorf("unterminated literal")
	}
	if n := lineTerminator(lx.src, lx.pos); n > 0 {
		lx.pos += n
		lx.line++
		return units, nil // a line continuation
	}
	c := lx.src[lx.pos]
	simple := map[byte]uint16{'n': '\n', 't': '\t', 'r': '\r', 'b': '\b', 'f': '\f', 'v': '\v'}
	if u, ok := simple[c]; ok {
		lx.pos++
		return append(units, u), nil
	}
	switch {
	case c == 'x':
		if lx.pos+3 > len(lx.src) {
			return nil, fmt.Errorf("bad \\x escape")
		}
		n, err := strconv.ParseUint(lx.src[lx.pos+1:lx.pos+3], 16, 8)
		if err != nil {
			return nil, fmt.Errorf("bad \\x escape")
		}
		lx.pos += 3
		return append(units, uint16(n)), nil
	case c == 'u':
		lx.pos++
		cp, err := lx.readUnicodeEscape()
		if err != nil {
			return nil, err
		}
		if cp < 0x10000 {
			// Kept as a unit, so a surrogate pair written as two escapes joins.
			return append(units, uint16(cp)), nil
		}
		return append(units, utf16.Encode([]rune{cp})...), nil
	case c >= '0' && c <= '7':
		// \0, or a legacy octal escape: up to three digits, at most 0377.
		end := lx.pos + 1
		for end < len(lx.src) && end < lx.pos+3 && lx.src[end] >= '0' && lx.src[end] <= '7' {
			end++
		}
		n, _ := strconv.ParseUint(lx.src[lx.pos:end], 8, 16)
		if n > 0o377 {
			end--
			n, _ = strconv.ParseUint(lx.src[lx.pos:end], 8, 16)
		}
		lx.pos = end
		return append(units, uint16(n)), nil
	}
	r, size := utf8.DecodeRuneInString(lx.src[lx.pos:])
	lx.pos += size
	return append(units, utf16.Encode([]rune{r})...), nil
}

func (lx *lexer) readString(quote byte) (string, error) {
	lx.pos++
	var units []uint16
	for {
		if lx.pos >= len(lx.src) {
			return "", fmt.Errorf("unterminated string")
		}
		c := lx.src[lx.pos]
		switch c {
		case quote:
			lx.pos++
			return string(utf16.Decode(units)), nil
		case '\\':
			var err error
			if units, err = lx.readEscape(units); err != nil {
				return "", err
			}
		case '\n', '\r':
			return "", fmt.Errorf("unterminated string")
		default:
			r, size := utf8.DecodeRuneInString(lx.src[lx.pos:])
			units = append(units, utf16.Encode([]rune{r})...)
			lx.pos += size
		}
	}
}

// readTemplate reads template text after a ` (head) or the } closing a
// substitution, up to the closing ` or the next ${.
func (lx *lexer) readTemplate(head bool, line int) error {
	var units []uint16
	for {
		if lx.pos >= len(lx.src) {
			return fmt.Errorf("unterminated template")
		}
		c := lx.src[lx.pos]
		switch {
		case c == '`':
			lx.pos++
			kind := tkTemplateTail
			if head {
				kind = tkTemplate
			}
			lx.emit(kind, string(utf16.Decode(units)), line)
			return nil
		case c == '$' && lx.pos+1 < len(lx.src) && lx.src[lx.pos+1] == '{':
			lx.pos += 2
			kind := tkTemplateMiddle
			if head {
				kind = tkTemplateHead
			}
			lx.emit(kind, "", line)
			lx.braces = append(lx.braces, true)
			return nil
		case c == '\\':
			var err error
			if units, err = lx.readEscape(units); err != nil {
				return err
			}
		case lineTerminator(lx.src, lx.pos) > 0:
			// A raw CR or CRLF reads as LF.
			n := lineTerminator(lx.src, lx.pos)
			if c == '\r' {
				units = append(units, '\n')
			} else {
				units = append(units, utf16.Encode([]rune(lx.src[lx.pos:lx.pos+n]))...)
			}
			lx.pos += n
			lx.line++
		default:
			r, size := utf8.DecodeRuneInString(lx.src[lx.pos:])
			units = append(units, utf16.Encode([]rune{r})...)
			lx.pos += size
		}
	}
}
