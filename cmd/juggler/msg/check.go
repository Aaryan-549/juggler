//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package msg

import (
	"errors"
	"fmt"
	"regexp"
	"slices"
	"sort"
	"strings"
)

// TranslationProblem is one way a translation of one message is wrong.
type TranslationProblem struct {
	// Kind names the rule broken: syntax, no-other, unknown-argument,
	// missing-argument, argument-kind, plural-category or html.
	Kind string
	// Message says what is wrong, worded as scripts/i18n words it.
	Message string
}

// CheckTranslation holds translation to its English source, as
// messageProblems() in scripts/i18n does, in the same order and words: it
// must parse; use exactly the source's argument names, each plural or select
// kept as one; give a plural only branches that are one of categories (the
// locale's plural categories; nil skips this) or `=N`; and hold no HTML markup
// the source does not.
func CheckTranslation(source, translation, locale string, categories []string) []TranslationProblem {
	nodes, err := parseStrict(translation)
	if err != nil {
		var noOther *missingOtherError
		if errors.As(err, &noOther) {
			return []TranslationProblem{{Kind: "no-other",
				Message: fmt.Sprintf(`{%s, %s, …} has no "other" branch, which every plural and select needs`, noOther.name, noOther.kind)}}
		}
		return []TranslationProblem{{Kind: "syntax", Message: "does not parse as a message — check its braces and apostrophes"}}
	}
	var out []TranslationProblem
	// An English source that does not parse is shown as written; there are
	// no arguments to hold the translation to.
	if sourceNodes, err := parseStrict(source); err == nil {
		want, got := argumentUses(sourceNodes, nil), argumentUses(nodes, nil)
		gotNames, wantNames := sortedNames(got), sortedNames(want)
		for _, name := range gotNames {
			if _, ok := want[name]; !ok {
				out = append(out, TranslationProblem{Kind: "unknown-argument",
					Message: fmt.Sprintf("uses {%s}, which the English does not have", name)})
			}
		}
		for _, name := range wantNames {
			if _, ok := got[name]; !ok {
				out = append(out, TranslationProblem{Kind: "missing-argument",
					Message: fmt.Sprintf("drops {%s}, which the English has", name)})
			}
		}
		for _, name := range gotNames {
			w, ok := want[name]
			if !ok {
				continue
			}
			if g, w := got[name]&(usePlural|useSelect), w&(usePlural|useSelect); g != w {
				out = append(out, TranslationProblem{Kind: "argument-kind",
					Message: fmt.Sprintf("uses {%s} as %s, but the English uses it as %s", name, describeUse(g), describeUse(w))})
			}
		}
	}
	if categories != nil {
		out = pluralCategoryProblems(nodes, locale, categories, out)
	}
	if tag := firstHTMLTag(translation); tag != "" && firstHTMLTag(source) == "" {
		out = append(out, TranslationProblem{Kind: "html",
			Message: fmt.Sprintf("has HTML markup (%s), which the English does not — put markup in a {placeholder} filled with htmlSlots()", tag)})
	}
	return out
}

// How a message uses an argument name, as a mask.
const (
	useArg = 1 << iota
	usePlural
	useSelect
)

// argumentUses adds how nodes use each argument name to uses.
func argumentUses(nodes []node, uses map[string]int) map[string]int {
	if uses == nil {
		uses = map[string]int{}
	}
	for _, n := range nodes {
		switch n.kind {
		case argNode:
			uses[n.text] |= useArg
		case pluralNode, selectNode:
			if n.kind == pluralNode {
				uses[n.text] |= usePlural
			} else {
				uses[n.text] |= useSelect
			}
			for _, branch := range n.options {
				argumentUses(branch, uses)
			}
		}
	}
	return uses
}

func sortedNames(uses map[string]int) []string {
	out := make([]string, 0, len(uses))
	for name := range uses {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

// describeUse is how an argument is used, as a problem names it.
func describeUse(mask int) string {
	var kinds []string
	if mask&usePlural != 0 {
		kinds = append(kinds, "a plural")
	}
	if mask&useSelect != 0 {
		kinds = append(kinds, "a select")
	}
	if len(kinds) == 0 {
		return "a plain placeholder"
	}
	return strings.Join(kinds, " and ")
}

// pluralCategoryProblems appends each plural branch of nodes whose keyword is
// neither one of categories nor `=N`, in document order with each node's keys
// sorted.
func pluralCategoryProblems(nodes []node, locale string, categories []string, out []TranslationProblem) []TranslationProblem {
	for _, n := range nodes {
		if n.kind != pluralNode && n.kind != selectNode {
			continue
		}
		keys := slices.Clone(n.keys)
		sort.Strings(keys)
		if n.kind == pluralNode {
			for _, key := range keys {
				if strings.HasPrefix(key, "=") || slices.Contains(categories, key) {
					continue
				}
				out = append(out, TranslationProblem{Kind: "plural-category", Message: fmt.Sprintf(
					`{%s, plural, …} has a "%s" branch, which is not a plural category in %s (%s) — use one of those, or =N`,
					n.text, key, locale, strings.Join(categories, ", "))})
			}
		}
		for _, key := range keys {
			out = pluralCategoryProblems(n.options[key], locale, categories, out)
		}
	}
	return out
}

// tagPattern is a tag: `<name>`, `</name>`, `<name/>` or `<name attrs…>`.
var tagPattern = regexp.MustCompile(`</?([A-Za-z][A-Za-z0-9]*)(?:[ \t\n\r\f/][^<>]*)?>`)

// htmlElements are the names that make a tag markup, so a usage placeholder
// such as `<project>` is text. scripts/i18n keeps the same list.
var htmlElements = func() map[string]bool {
	out := map[string]bool{}
	for _, name := range strings.Fields(`a abbr address area article aside audio b bdi bdo big blockquote body br button
		canvas caption center cite code col colgroup dd del details dfn dialog div dl dt em embed fieldset
		figcaption figure font footer form h1 h2 h3 h4 h5 h6 head header hr html i iframe img input ins kbd
		label legend li link main mark meta meter nav noscript object ol optgroup option output p picture pre
		progress q rp rt ruby s samp script section select small source span strike strong style sub summary
		sup svg table tbody td template textarea tfoot th thead time title tr track tt u ul var video wbr`) {
		out[name] = true
	}
	return out
}()

// firstHTMLTag is the first HTML tag in text, or "".
func firstHTMLTag(text string) string {
	for _, m := range tagPattern.FindAllStringSubmatch(text, -1) {
		if htmlElements[strings.ToLower(m[1])] {
			return m[0]
		}
	}
	return ""
}
