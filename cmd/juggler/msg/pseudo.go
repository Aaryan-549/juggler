//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package msg

import (
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode"
)

// The pseudo-locale is a port of pseudoLocalize in web/sdk/lib/i18n.js, held
// to it by a fixture both test suites run
// (web/js-tests/fixtures/i18n-pseudo-parity.json), so an en-XA.json written
// here is the one scripts/i18n writes.

// pseudoLetters maps each ASCII letter to its accented stand-in.
var pseudoLetters = func() map[rune]rune {
	plain := []rune("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")
	accented := []rune("åƀçðéƒĝĥîĵķļɱñöþǫŕšţûṽŵẋýžÅƁÇÐÉƑĜĤÎĴĶĻṀÑÖÞǪŔŠŢÛṼŴẊÝŽ")
	m := make(map[rune]rune, len(plain))
	for i, r := range plain {
		m[r] = accented[i]
	}
	return m
}()

const (
	// pseudoPad marks where a longer translation would clip.
	pseudoPad = "·"
	// pseudoExpansion is how much longer the pseudo message is than its English.
	pseudoExpansion = 0.35
)

// PseudoLocalize pseudo-localises an English message: every ASCII letter
// accented, the whole wrapped in `[…]` and padded by about a third.
// Placeholders, plural/select syntax and quoting survive, so the result is
// itself a valid message. A message that does not parse is returned as it is.
func PseudoLocalize(message string) string {
	nodes, ok := parse(message)
	if !ok {
		return message
	}
	// The explicit conversion rounds the product, as JS does, before jsRound
	// subtracts from it: unconverted, the compiler may fuse the two into one
	// multiply-add, and 10 letters would pad by 3 rather than JS's 4.
	scaled := float64(float64(countLetters(nodes)) * pseudoExpansion)
	pad := max(1, int(jsRound(scaled)))
	return "[" + serialize(nodes, false, true) + " " + strings.Repeat(pseudoPad, pad) + "]"
}

// jsRound is JS's Math.round: to the nearest integer, halves up.
func jsRound(x float64) float64 {
	r := math.Floor(x)
	if x-r >= 0.5 {
		r++
	}
	return r
}

// countLetters counts the letters in nodes' literal text, taking the longest
// branch of each plural or select (the one that has to fit).
func countLetters(nodes []node) int {
	n := 0
	for _, nd := range nodes {
		switch nd.kind {
		case textNode:
			for _, r := range nd.text {
				if unicode.IsLetter(r) {
					n++
				}
			}
		case pluralNode, selectNode:
			longest := 0
			for _, branch := range nd.options {
				longest = max(longest, countLetters(branch))
			}
			n += longest
		}
	}
	return n
}

// serialize writes nodes back out as message text, optionally accenting the
// literals.
func serialize(nodes []node, inPlural, accent bool) string {
	var b strings.Builder
	for _, nd := range nodes {
		switch nd.kind {
		case textNode:
			text := nd.text
			if accent {
				text = strings.Map(func(r rune) rune {
					if a, ok := pseudoLetters[r]; ok {
						return a
					}
					return r
				}, text)
			}
			// Quote from the first syntax character through the end in one
			// section: adjacent quoted sections read as an escaped apostrophe.
			syntax := "{}"
			if inPlural {
				syntax = "{}#"
			}
			if i := strings.IndexAny(text, syntax); i >= 0 {
				b.WriteString(strings.ReplaceAll(text[:i], "'", "''"))
				b.WriteString("'" + strings.ReplaceAll(text[i:], "'", "''") + "'")
			} else {
				b.WriteString(strings.ReplaceAll(text, "'", "''"))
			}
		case argNode:
			b.WriteString("{" + nd.text + "}")
		case poundNode:
			b.WriteString("#")
		case pluralNode, selectNode:
			kind := "select"
			if nd.kind == pluralNode {
				kind = "plural"
			}
			branches := make([]string, 0, len(nd.keys))
			for _, key := range jsPropertyOrder(nd.keys) {
				branches = append(branches, key+" {"+serialize(nd.options[key], inPlural || nd.kind == pluralNode, accent)+"}")
			}
			b.WriteString("{" + nd.text + ", " + kind + ", " + strings.Join(branches, " ") + "}")
		}
	}
	return b.String()
}

// jsPropertyOrder is the order a JS object enumerates keys inserted in the
// order given: array indices first, ascending, then the rest as inserted.
func jsPropertyOrder(keys []string) []string {
	var indices, rest []string
	for _, k := range keys {
		if IsArrayIndex(k) {
			indices = append(indices, k)
		} else {
			rest = append(rest, k)
		}
	}
	sort.Slice(indices, func(i, j int) bool {
		a, _ := strconv.ParseUint(indices[i], 10, 64)
		b, _ := strconv.ParseUint(indices[j], 10, 64)
		return a < b
	})
	return append(indices, rest...)
}

// IsArrayIndex reports whether a JS object would treat key as an array index —
// a canonical decimal integer below 2³²−1 — and so enumerate it before its
// other keys, in numeric order.
func IsArrayIndex(key string) bool {
	if key == "" || len(key) > 10 || (len(key) > 1 && key[0] == '0') {
		return false
	}
	n, err := strconv.ParseUint(key, 10, 64)
	return err == nil && n < math.MaxUint32
}
