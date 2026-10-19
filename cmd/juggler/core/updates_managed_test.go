//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"strings"
	"testing"
)

func TestUpdatesManagedBy(t *testing.T) {
	long := strings.Repeat("x", 60)
	cases := []struct {
		env, name, via string
	}{
		{"", "", ""},
		{"   ", "", ""},
		{"Nix", "Nix", "nix"},
		{"  Homebrew \n", "Homebrew", "homebrew"},
		{"Home brew!", "Home brew!", "home-brew"},
		{"--AUR--", "--AUR--", "aur"},
		{"Flatpak (Flathub)", "Flatpak (Flathub)", "flatpak-flathub"},
		{"!!!", "!!!", ""},
		{"Nix\x07\x1b", "Nix", "nix"},
		{long, long[:maxManagedByLen], long[:maxViaLen]},
	}
	for _, c := range cases {
		t.Setenv(UpdatesManagedByEnv, c.env)
		if got := UpdatesManagedBy(); got != c.name {
			t.Errorf("UpdatesManagedBy() with %q = %q, want %q", c.env, got, c.name)
		}
		if got := UpdatesVia(); got != c.via {
			t.Errorf("UpdatesVia() with %q = %q, want %q", c.env, got, c.via)
		}
	}
}

func TestSetUpdatesManagedByExportsToChildren(t *testing.T) {
	t.Setenv(UpdatesManagedByEnv, "")
	if err := SetUpdatesManagedBy("Nix"); err != nil {
		t.Fatal(err)
	}
	if got := UpdatesManagedBy(); got != "Nix" {
		t.Fatalf("UpdatesManagedBy() = %q after SetUpdatesManagedBy(\"Nix\")", got)
	}
}
