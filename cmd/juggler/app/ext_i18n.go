//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"juggler/cmd/juggler/i18nextract"
)

const extI18nUsage = `Usage: juggler ext i18n <command> [path]

Maintain the translation catalogue of the extension at [path] (default .): the
directory its manifest names in provides.i18n.

Commands:
  extract   Collect every message in the extension's source into en.json and
            regenerate the pseudo-locale en-XA.json; report keys in other
            locales' files that no longer exist (the English changed).
  pseudo    Regenerate en-XA.json from en.json as it stands.
  check     Exit 1 if en.json or en-XA.json is out of date with the source, or
            if any other locale's file has a problem: a key the source no
            longer has, a translation that does not parse, placeholders that
            differ from the English, a plural branch the locale does not have,
            or HTML markup the English does not have. An empty translation
            counts as untranslated.
`

// extI18n runs `juggler ext i18n …` on the process's stdout and stderr.
func extI18n(args []string) int {
	return runExtI18n(args, os.Stdout, os.Stderr)
}

// runExtI18n runs `juggler ext i18n <extract|pseudo|check> [path]`. It exits 0
// on success, 1 when the catalogue cannot be made or is out of date or a
// message cannot be extracted, and 2 on a usage error.
func runExtI18n(args []string, stdout, stderr io.Writer) int {
	if len(args) == 1 && (args[0] == "-h" || args[0] == "--help" || args[0] == "help") {
		fmt.Fprint(stderr, extI18nUsage)
		return 0
	}
	if len(args) < 1 || len(args) > 2 {
		fmt.Fprint(stderr, extI18nUsage)
		return 2
	}
	dir := "."
	if len(args) == 2 && strings.TrimSpace(args[1]) != "" {
		dir = strings.TrimSpace(args[1])
	}
	switch args[0] {
	case "extract":
		return i18nExtract(dir, stdout, stderr)
	case "pseudo":
		return i18nPseudo(dir, stdout, stderr)
	case "check":
		return i18nCheck(dir, stderr)
	}
	fmt.Fprint(stderr, extI18nUsage)
	return 2
}

// catalogLabel names a catalogue directory in output, as the user wrote the path.
func catalogLabel(dir string) string {
	return filepath.ToSlash(dir)
}

func i18nExtract(root string, stdout, stderr io.Writer) int {
	ext, err := i18nextract.Extract(root)
	if err != nil {
		fmt.Fprintf(stderr, "juggler ext i18n: %v\n", err)
		return 1
	}
	if err := writeCatalogs(ext.CatalogDir, ext.Messages); err != nil {
		fmt.Fprintf(stderr, "juggler ext i18n: %v\n", err)
		return 1
	}
	label := catalogLabel(ext.CatalogDir)
	fmt.Fprintf(stdout, "%s/en.json: %d message(s); en-XA regenerated\n", label, len(ext.Messages))
	files, err := translationFiles(ext.CatalogDir)
	if err != nil {
		fmt.Fprintf(stderr, "juggler ext i18n: %v\n", err)
		return 1
	}
	for _, file := range files {
		catalog, err := readCatalogFile(filepath.Join(ext.CatalogDir, file))
		if err != nil {
			fmt.Fprintf(stderr, "juggler ext i18n: %s/%s: %v\n", label, file, err)
			return 1
		}
		var stale []string
		for k := range catalog {
			if _, ok := ext.Messages[k]; !ok {
				stale = append(stale, k)
			}
		}
		if len(stale) == 0 {
			continue
		}
		sort.Strings(stale)
		fmt.Fprintf(stdout, "%s/%s: %d stale key(s) — the English changed or was removed:\n", label, file, len(stale))
		for _, k := range stale {
			quoted, _ := json.Marshal(k)
			fmt.Fprintf(stdout, "  %s\n", quoted)
		}
	}
	for _, p := range ext.Problems {
		fmt.Fprintln(stderr, p)
	}
	if len(ext.Problems) > 0 {
		return 1
	}
	return 0
}

func i18nPseudo(root string, stdout, stderr io.Writer) int {
	dir, _, err := i18nextract.CatalogDir(root)
	if err != nil {
		fmt.Fprintf(stderr, "juggler ext i18n: %v\n", err)
		return 1
	}
	messages, err := readCatalogFile(filepath.Join(dir, "en.json"))
	if err != nil {
		fmt.Fprintf(stderr, "juggler ext i18n: %v\n", err)
		return 1
	}
	if err := writeCatalogs(dir, messages); err != nil {
		fmt.Fprintf(stderr, "juggler ext i18n: %v\n", err)
		return 1
	}
	fmt.Fprintf(stdout, "%s/en-XA.json regenerated\n", catalogLabel(dir))
	return 0
}

func i18nCheck(root string, stderr io.Writer) int {
	ext, err := i18nextract.Extract(root)
	if err != nil {
		fmt.Fprintf(stderr, "juggler ext i18n: %v\n", err)
		return 1
	}
	status := 0
	for _, p := range ext.Problems {
		fmt.Fprintln(stderr, p)
		status = 1
	}
	// A Windows checkout may have CRLF line endings; only content counts.
	read := func(name string) []byte {
		data, _ := os.ReadFile(filepath.Join(ext.CatalogDir, name))
		return bytes.ReplaceAll(data, []byte("\r\n"), []byte("\n"))
	}
	if !bytes.Equal(read("en.json"), i18nextract.Serialize(ext.Messages)) ||
		!bytes.Equal(read("en-XA.json"), i18nextract.Serialize(i18nextract.Pseudo(ext.Messages))) {
		fmt.Fprintf(stderr, "%s/en.json or en-XA.json is out of date with the messages in the source.\n", catalogLabel(ext.CatalogDir))
		fmt.Fprintf(stderr, "Run: juggler ext i18n extract %s\n", root)
		status = 1
	}
	files, err := translationFiles(ext.CatalogDir)
	if err != nil && !os.IsNotExist(err) {
		fmt.Fprintf(stderr, "juggler ext i18n: %v\n", err)
		return 1
	}
	label := catalogLabel(ext.CatalogDir)
	for _, file := range files {
		data, err := os.ReadFile(filepath.Join(ext.CatalogDir, file))
		if err != nil {
			fmt.Fprintf(stderr, "juggler ext i18n: %v\n", err)
			return 1
		}
		for _, p := range i18nextract.CheckTranslation(ext.Messages, data, strings.TrimSuffix(file, ".json")) {
			where := ""
			if p.Key != nil {
				where = " " + i18nextract.QuoteKey(*p.Key) + ":"
			}
			fmt.Fprintf(stderr, "%s/%s:%s %s\n", label, file, where, p.Message)
			status = 1
		}
	}
	return status
}

// writeCatalogs writes en.json and its pseudo-locale en-XA.json into dir.
func writeCatalogs(dir string, messages map[string]string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, "en.json"), i18nextract.Serialize(messages), 0o644); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "en-XA.json"), i18nextract.Serialize(i18nextract.Pseudo(messages)), 0o644)
}

// readCatalogFile reads a catalogue; an absent one is empty.
func readCatalogFile(file string) (map[string]string, error) {
	data, err := os.ReadFile(file)
	if os.IsNotExist(err) {
		return map[string]string{}, nil
	}
	if err != nil {
		return nil, err
	}
	var messages map[string]string
	if err := json.Unmarshal(data, &messages); err != nil {
		return nil, fmt.Errorf("%s: %w", file, err)
	}
	return messages, nil
}

// translationFiles lists the real-language catalogues in dir: every .json but
// en.json and en-XA.json.
func translationFiles(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, e := range entries {
		name := e.Name()
		if strings.HasSuffix(name, ".json") && name != "en.json" && name != "en-XA.json" {
			out = append(out, name)
		}
	}
	return out, nil
}
