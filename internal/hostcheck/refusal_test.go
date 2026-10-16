//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package hostcheck

import (
	"strings"
	"testing"
)

// TestRefusalNamesTheHostAndTheFix pins what a refused caller is told: the
// Host that was refused, which names are accepted without configuration, and
// the --allow-host flag that admits this one, spelled without its port since
// that is how the flag takes it.
func TestRefusalNamesTheHostAndTheFix(t *testing.T) {
	msg := Refusal("Juggler.Example.com:3939")
	for _, want := range []string{
		`"Juggler.Example.com:3939"`,
		"DNS rebinding",
		"localhost",
		".local, .internal, .home.arpa or .lan",
		"--allow-host juggler.example.com",
	} {
		if !strings.Contains(msg, want) {
			t.Errorf("Refusal message lacks %q:\n%s", want, msg)
		}
	}
	// --allow-host would reject anything that is not a plain DNS name, so a
	// Host that is not one gets no suggestion to pass it.
	for _, h := range []string{"", "bad_name.example.com", "x.example.com."} {
		if msg := Refusal(h); strings.Contains(msg, "--allow-host") {
			t.Errorf("Refusal(%q) suggests --allow-host:\n%s", h, msg)
		}
	}
}
