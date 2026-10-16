//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package i18nextract

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"juggler/cmd/juggler/msg"
)

// Serialize is the catalogue file text for messages, exactly as scripts/i18n
// writes it — JSON.stringify(sorted, null, 2) + '\n' — so a catalogue reads
// the same whichever tool wrote it. JS sorts keys by UTF-16 code unit and an
// object enumerates array-index keys first, in numeric order; JSON.stringify
// escapes only quotes, backslashes and control characters.
func Serialize(messages map[string]string) []byte {
	if len(messages) == 0 {
		return []byte("{}\n")
	}
	keys := make([]string, 0, len(messages))
	for k := range messages {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		a, b := keys[i], keys[j]
		ai, bi := msg.IsArrayIndex(a), msg.IsArrayIndex(b)
		switch {
		case ai && bi:
			x, _ := strconv.ParseUint(a, 10, 64)
			y, _ := strconv.ParseUint(b, 10, 64)
			return x < y
		case ai != bi:
			return ai
		}
		return utf16Less(a, b)
	})
	var b strings.Builder
	b.WriteString("{\n")
	for i, k := range keys {
		b.WriteString("  " + jsonString(k) + ": " + jsonString(messages[k]))
		if i < len(keys)-1 {
			b.WriteString(",")
		}
		b.WriteString("\n")
	}
	b.WriteString("}\n")
	return []byte(b.String())
}

// QuoteKey is a catalogue key as scripts/i18n quotes it in a problem:
// JSON.stringify, which leaves <, > and & alone.
func QuoteKey(key string) string {
	return jsonString(key)
}

// jsonString is JSON.stringify of a string.
func jsonString(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 0x20 {
				fmt.Fprintf(&b, `\u%04x`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}

// utf16Less orders strings as JS's default sort does: by UTF-16 code unit,
// which puts a character beyond U+FFFF (a surrogate pair) before U+E000–U+FFFF.
func utf16Less(a, b string) bool {
	for a != "" && b != "" {
		ra, na := utf8.DecodeRuneInString(a)
		rb, nb := utf8.DecodeRuneInString(b)
		if ra != rb {
			ua, ub := firstUnit(ra), firstUnit(rb)
			if ua != ub {
				return ua < ub
			}
			return ra < rb
		}
		a, b = a[na:], b[nb:]
	}
	return len(a) < len(b)
}

// firstUnit is the first UTF-16 code unit of r.
func firstUnit(r rune) rune {
	if r < 0x10000 {
		return r
	}
	return 0xD800 + (r-0x10000)>>10
}
