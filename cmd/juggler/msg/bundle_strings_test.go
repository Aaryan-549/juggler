//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package msg

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
)

// bundleScript generates the installers' localized text from the catalogues.
const bundleScript = "../../../scripts/i18n-bundle"

// packagingMessages is the English source of that text.
const packagingMessages = "../../../packaging/messages.json"

// The English the stand-in catalogues translate.
const (
	micSentence = "A program you ran from Juggler asked to use the microphone."
	launchText  = "Launch Juggler"
	pathText    = "Add Juggler to PATH (run 'juggler' from any terminal)"
)

// runBundle runs scripts/i18n-bundle with args, returning its combined output
// and whether it exited zero. Skips when there is no node to run it with.
func runBundle(t *testing.T, args ...string) (string, bool) {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	out, err := exec.Command(node, append([]string{bundleScript}, args...)...).CombinedOutput()
	return string(out), err == nil
}

// writeJSON writes v as JSON to dir/name.
func writeJSON(t *testing.T, dir, name string, v any) {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, name), data, 0o600); err != nil {
		t.Fatal(err)
	}
}

// standInCatalogs makes a catalogue directory holding the source list, the
// pseudo-locale, a French catalogue translating two of the messages (one with
// characters each output format must escape), a Brazilian Portuguese one
// translating none, and an Esperanto one, which Inno Setup has no language for.
func standInCatalogs(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	writeJSON(t, dir, "en.json", map[string]string{micSentence: micSentence, launchText: launchText})
	writeJSON(t, dir, "en-XA.json", map[string]string{micSentence: "[Ⓐ ƥȓôĝȓàɱ]", launchText: "[Ŀàüñçĥ]"})
	writeJSON(t, dir, "fr.json", map[string]string{
		micSentence: `Un programme lancé depuis Juggler veut utiliser le « micro » "intégré" \ & <ici>.`,
		pathText:    "Ajouter Juggler au PATH",
	})
	writeJSON(t, dir, "pt-BR.json", map[string]string{})
	writeJSON(t, dir, "eo.json", map[string]string{launchText: "Lanĉi Juggler"})
	return dir
}

// readText reads a file the test expects to exist.
func readText(t *testing.T, file string) string {
	t.Helper()
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatalf("read %s: %v", file, err)
	}
	return string(data)
}

// lintPlist runs plutil -lint over a property list or .strings file, on macOS,
// where it is how Apple's own parser judges the file.
func lintPlist(t *testing.T, file string) {
	t.Helper()
	if runtime.GOOS != "darwin" {
		return
	}
	if out, err := exec.Command("plutil", "-lint", file).CombinedOutput(); err != nil {
		t.Errorf("plutil -lint %s: %v\n%s", file, err, out)
	}
}

// `scripts/i18n-bundle mac <Contents>` declares every real catalogue as a
// localization of the bundle and gives each its InfoPlist.strings, holding the
// Info.plist text that catalogue translates.
func TestBundleStringsMac(t *testing.T) {
	catalogs := standInCatalogs(t)
	contents := t.TempDir()
	plist := filepath.Join(contents, "Info.plist")
	if err := os.WriteFile(plist, []byte(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Juggler</string>
</dict></plist>
`), 0o600); err != nil {
		t.Fatal(err)
	}
	stale := filepath.Join(contents, "Resources", "de.lproj")
	if err := os.MkdirAll(stale, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stale, "InfoPlist.strings"), []byte("\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	if out, ok := runBundle(t, "mac", contents, "--catalog", catalogs); !ok {
		t.Fatalf("mac failed:\n%s", out)
	}

	got := readText(t, plist)
	for _, want := range []string{
		"<key>CFBundleLocalizations</key><array><string>en</string><string>eo</string><string>fr</string><string>pt-BR</string></array>",
		"<key>NSMicrophoneUsageDescription</key><string>" + micSentence + "</string>",
		"<key>CFBundleName</key><string>Juggler</string>",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("Info.plist lacks %s:\n%s", want, got)
		}
	}
	if strings.Contains(got, "en-XA") {
		t.Errorf("Info.plist names the pseudo-locale:\n%s", got)
	}
	lintPlist(t, plist)

	resources := filepath.Join(contents, "Resources")
	entries, err := os.ReadDir(resources)
	if err != nil {
		t.Fatal(err)
	}
	var lprojs []string
	for _, e := range entries {
		lprojs = append(lprojs, e.Name())
	}
	sort.Strings(lprojs)
	if want := "en.lproj eo.lproj fr.lproj pt-BR.lproj"; strings.Join(lprojs, " ") != want {
		t.Errorf("Resources = %q, want %s (no pseudo-locale, no stale de)", lprojs, want)
	}

	strs := func(id string) string {
		file := filepath.Join(resources, id+".lproj", "InfoPlist.strings")
		lintPlist(t, file)
		return readText(t, file)
	}
	if got := strs("en"); !strings.Contains(got, `"NSMicrophoneUsageDescription" = "`+micSentence+`";`) {
		t.Errorf("en InfoPlist.strings = %q", got)
	}
	wantFr := `"NSMicrophoneUsageDescription" = "Un programme lancé depuis Juggler veut utiliser le « micro » \"intégré\" \\ & <ici>.";`
	if got := strs("fr"); !strings.Contains(got, wantFr) {
		t.Errorf("fr InfoPlist.strings = %q\nwant it to hold %s", got, wantFr)
	}
	if got := strs("pt-BR"); strings.Contains(got, "NSMicrophoneUsageDescription") {
		t.Errorf("pt-BR translates nothing, so its InfoPlist.strings should leave the Info.plist English: %q", got)
	}
}

// `scripts/i18n-bundle inno <file>` writes the installer's languages — English
// and each real catalogue Inno Setup has a language for — and its custom
// messages, translated from each catalogue and falling back to English.
func TestBundleStringsInno(t *testing.T) {
	catalogs := standInCatalogs(t)
	out := filepath.Join(t.TempDir(), "languages.iss")
	if msg, ok := runBundle(t, "inno", out, "--catalog", catalogs); !ok {
		t.Fatalf("inno failed:\n%s", msg)
	}
	got := readText(t, out)
	if !strings.HasPrefix(got, "\uFEFF") {
		t.Errorf("languages.iss has no UTF-8 byte-order mark, so Inno Setup would read it as ANSI")
	}
	for _, want := range []string{
		`Name: "english"; MessagesFile: "compiler:Default.isl"`,
		`#if FileExists(CompilerPath + "Languages\French.isl")`,
		`Name: "french"; MessagesFile: "compiler:Languages\French.isl"`,
		`Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"`,
		"english.LaunchJuggler=" + launchText + "\r\n",
		"french.AddToPath=Ajouter Juggler au PATH\r\n",
		"french.LaunchJuggler=" + launchText + "\r\n",
		"brazilianportuguese.AddToPath=" + pathText + "\r\n",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("languages.iss lacks %q:\n%s", want, got)
		}
	}
	for _, unwanted := range []string{"XA", "Lanĉi"} {
		if strings.Contains(got, unwanted) {
			t.Errorf("languages.iss holds %q (the pseudo-locale, or a language Inno lacks):\n%s", unwanted, got)
		}
	}

	// A message Inno would read as a format argument is refused, not shipped.
	writeJSON(t, catalogs, "fr.json", map[string]string{launchText: "Lancer Juggler à 100%"})
	if msg, ok := runBundle(t, "inno", out, "--catalog", catalogs); ok || !strings.Contains(msg, "fr") {
		t.Errorf("inno accepted a %% in a translation, or did not name the catalogue:\n%s", msg)
	}
}

// The installer text the generator emits is English source in packaging/
// messages.json, which extraction carries into web/i18n/en.json — so a
// reworded sentence fails `scripts/i18n check` until the catalogue follows —
// and the installer script asks for each of its messages by name.
func TestPackagingMessagesCatalogued(t *testing.T) {
	var sources map[string]map[string]string
	if err := json.Unmarshal([]byte(readText(t, packagingMessages)), &sources); err != nil {
		t.Fatalf("parse %s: %v", packagingMessages, err)
	}
	en := readCatalog(t, "../../../web/i18n/en.json")
	for section, messages := range sources {
		for name, english := range messages {
			if en[english] != english {
				t.Errorf("%s.%s %q is not in web/i18n/en.json — run node scripts/i18n extract", section, name, english)
			}
		}
	}
	if sources["infoPlist"]["NSMicrophoneUsageDescription"] == "" {
		t.Errorf("packaging/messages.json has no infoPlist.NSMicrophoneUsageDescription")
	}
	iss := readText(t, "../../../packaging/windows/juggler.iss")
	if len(sources["inno"]) == 0 {
		t.Errorf("packaging/messages.json has no inno messages")
	}
	for name, english := range sources["inno"] {
		if !strings.Contains(iss, "{cm:"+name+"}") {
			t.Errorf("juggler.iss never uses {cm:%s}", name)
		}
		if strings.Contains(iss, english) {
			t.Errorf("juggler.iss still spells out %q instead of {cm:%s}", english, name)
		}
	}
	if !strings.Contains(iss, `#include "..\..\bin\windows\languages.iss"`) {
		t.Errorf("juggler.iss does not include the generated languages.iss")
	}
}
