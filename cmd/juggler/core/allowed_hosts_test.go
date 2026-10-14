//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"juggler/internal/userpaths"
	"juggler/internal/userpaths/userpathstest"
)

// TestResolveAllowedHostsMergesSettingAndFlags: the setting's names and every
// --allow-host are allowed together.
func TestResolveAllowedHostsMergesSettingAndFlags(t *testing.T) {
	a, warnings, err := ResolveAllowedHosts([]string{"box.tailnet.ts.net"}, []string{"juggler.example.com", "BOX.tailnet.ts.net"})
	if err != nil || len(warnings) != 0 {
		t.Fatalf("ResolveAllowedHosts = %v, %q; want no error or warnings", err, warnings)
	}
	if got, want := a.Names(), []string{"box.tailnet.ts.net", "juggler.example.com"}; !slices.Equal(got, want) {
		t.Fatalf("Names() = %q, want %q", got, want)
	}
}

// TestResolveAllowedHostsRefusesABadFlag: a name typed on the command line is
// refused outright — the user is there to read the error and fix it.
func TestResolveAllowedHostsRefusesABadFlag(t *testing.T) {
	if _, _, err := ResolveAllowedHosts(nil, []string{"*.ts.net"}); err == nil {
		t.Fatal("ResolveAllowedHosts accepted --allow-host *.ts.net")
	}
}

// TestResolveAllowedHostsSkipsABadSettingEntry: a bad entry in settings.json
// (a hand edit) must never stop the server starting — a desktop launch has
// nowhere to show the error — so it is skipped with a warning naming it, and
// the good entries still apply.
func TestResolveAllowedHostsSkipsABadSettingEntry(t *testing.T) {
	a, warnings, err := ResolveAllowedHosts([]string{"https://bad.example.com", "good.example.com"}, nil)
	if err != nil {
		t.Fatalf("ResolveAllowedHosts: %v", err)
	}
	if len(warnings) != 1 || !strings.Contains(warnings[0], "https://bad.example.com") {
		t.Fatalf("warnings = %q, want one naming the bad entry", warnings)
	}
	if !a.Has("good.example.com") || a.Has("bad.example.com") {
		t.Fatalf("Names() = %q, want only good.example.com", a.Names())
	}
}

// TestLoadGlobalSettingsReadsAllowedHosts: the key is read from settings.json.
func TestLoadGlobalSettingsReadsAllowedHosts(t *testing.T) {
	userpathstest.Isolate(t)
	if err := os.MkdirAll(userpaths.ConfigDir(), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(userpaths.ConfigDir(), "settings.json"),
		[]byte(`{"connectivity":{"allowedHosts":["box.tailnet.ts.net"]}}`), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	gs, err := LoadGlobalSettings()
	if err != nil {
		t.Fatalf("LoadGlobalSettings: %v", err)
	}
	if !slices.Equal(gs.Connectivity.AllowedHosts, []string{"box.tailnet.ts.net"}) {
		t.Fatalf("allowedHosts = %q, want [box.tailnet.ts.net]", gs.Connectivity.AllowedHosts)
	}
}
