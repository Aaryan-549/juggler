//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package hostcheck

import "testing"

// TestNamesThisMachine pins the rule's boundary: every name a public website
// cannot own is admitted (what a user types to reach a box on their own
// network), and every name under a public suffix is refused, however it is
// dressed up.
func TestNamesThisMachine(t *testing.T) {
	admitted := []string{
		// Loopback names and address literals.
		"localhost", "localhost:3939", "LocalHost", "myproject.localhost:8317", "a.b.localhost",
		"127.0.0.1:3939", "192.168.1.5", "[::1]:3939", "fe80::1%en0",
		// Names on the user's own network.
		"juggler", "juggler:3939", "MyBox:3939",
		"mymac.local:3939", "MyMac.LOCAL",
		"box.internal:3939", "nas.home.arpa", "router.lan:80",
	}
	refused := []string{
		"", ":3939",
		"attacker.com", "attacker.com:3939", "juggler.example.com:3939",
		"localhost.attacker.com", "notlocalhost.com:3939",
		"local.attacker.com", "internal.attacker.com:3939", "lan.attacker.com",
		"juggler.", "mymac.local.", // a trailing dot makes a single label absolute: a TLD
	}
	for _, h := range admitted {
		if !NamesThisMachine(h) {
			t.Errorf("NamesThisMachine(%q) = false, want true", h)
		}
	}
	for _, h := range refused {
		if NamesThisMachine(h) {
			t.Errorf("NamesThisMachine(%q) = true, want false", h)
		}
	}
}
