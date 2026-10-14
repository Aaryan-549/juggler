//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package hostcheck

import (
	"slices"
	"testing"
)

// TestAllowListHas pins what an allowed name matches: that exact name, in any
// case and on any port — and nothing that merely contains it.
func TestAllowListHas(t *testing.T) {
	a, err := NewAllowList([]string{"My-Machine.Tailnet.ts.net", "juggler.example.com"})
	if err != nil {
		t.Fatalf("NewAllowList: %v", err)
	}
	matched := []string{
		"my-machine.tailnet.ts.net", "MY-MACHINE.TAILNET.TS.NET",
		"my-machine.tailnet.ts.net:443", "juggler.example.com:3939",
	}
	unmatched := []string{
		"", "tailnet.ts.net", "other.tailnet.ts.net",
		"my-machine.tailnet.ts.net.attacker.com", "x.my-machine.tailnet.ts.net",
		"my-machine.tailnet.ts.net.", "example.com", "localhost",
	}
	for _, h := range matched {
		if !a.Has(h) {
			t.Errorf("Has(%q) = false, want true", h)
		}
	}
	for _, h := range unmatched {
		if a.Has(h) {
			t.Errorf("Has(%q) = true, want false", h)
		}
	}
	if got, want := a.Names(), []string{"juggler.example.com", "my-machine.tailnet.ts.net"}; !slices.Equal(got, want) {
		t.Errorf("Names() = %q, want %q", got, want)
	}
}

// TestAllowListRejectsWhatIsNotAName refuses, with an error, every entry that
// is not one plain DNS name: a wildcard would hand rebinding a whole zone, and
// an address, a port or a URL means the user meant something else.
func TestAllowListRejectsWhatIsNotAName(t *testing.T) {
	for _, bad := range []string{
		"", "  ", "*.ts.net", "my-machine.ts.net:443", "https://my-machine.ts.net",
		"my-machine.ts.net/", "127.0.0.1", "::1", "my machine.ts.net", "my-machine.ts.net.",
	} {
		if _, err := NewAllowList([]string{bad}); err == nil {
			t.Errorf("NewAllowList(%q) succeeded, want an error", bad)
		}
	}
}

// TestAllowListEmpty is the zero value and an empty list alike: nothing allowed.
func TestAllowListEmpty(t *testing.T) {
	var zero AllowList
	if zero.Has("localhost") || len(zero.Names()) != 0 {
		t.Error("zero AllowList allows something")
	}
	a, err := NewAllowList(nil)
	if err != nil || a.Has("x.ts.net") {
		t.Errorf("NewAllowList(nil) = %v, %v; want an empty list", a, err)
	}
}
