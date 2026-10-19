//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package sysopen

import (
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// Go quotes a Windows argument only when it holds a space, tab or quote, so
// "&", "|" and "^" in a URL or file name reach whatever parses the command line
// bare. Through cmd.exe, a link in rendered markdown such as
// https://x/?a=1&calc ends the start command and runs calc — and every ordinary
// query string with a second parameter is cut short. The opener must take the
// target as one argument and parse nothing in it.
func TestWindowsOpenerNeverGoesThroughCmd(t *testing.T) {
	for _, target := range []string{
		"https://x.example/?a=1&calc",
		"https://x.example/?q=a|b^c",
		`C:\work\R&D.txt`,
	} {
		argv := Argv("windows", target)
		for _, a := range argv {
			if base := strings.ToLower(filepath.Base(strings.ReplaceAll(a, `\`, "/"))); base == "cmd" || base == "cmd.exe" {
				t.Fatalf("Argv(%q) goes through cmd.exe: %q", target, argv)
			}
		}
		if argv[len(argv)-1] != target || slices.Index(argv, target) != len(argv)-1 {
			t.Fatalf("Argv(%q) = %q: the target must be passed whole, as the last argument", target, argv)
		}
	}
}

func TestOpenersElsewhere(t *testing.T) {
	if got := Argv("darwin", "https://a/?b&c"); !slices.Equal(got, []string{"open", "https://a/?b&c"}) {
		t.Errorf("darwin: %q", got)
	}
	if got := Argv("linux", "https://a/?b&c"); !slices.Equal(got, []string{"xdg-open", "https://a/?b&c"}) {
		t.Errorf("linux: %q", got)
	}
}
