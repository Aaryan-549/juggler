//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"juggler/cmd/juggler/msg"
)

// fakeTunnelProvider is a no-op TunnelProvider for registry-dispatch tests.
type fakeTunnelProvider struct {
	mode TunnelMode
	host TunnelHost
	done chan struct{}
}

func (p *fakeTunnelProvider) Mode() TunnelMode      { return p.mode }
func (p *fakeTunnelProvider) Done() <-chan struct{} { return p.done }
func (p *fakeTunnelProvider) Stop()                 {}
func (p *fakeTunnelProvider) Start(context.Context) (TunnelInfo, error) {
	return TunnelInfo{Mode: p.mode}, nil
}

// withTestTunnelModes swaps the registry for the duration of a test. The
// registry is a startup-time package global, so tests that exercise it must
// save/restore rather than leak modes into other tests.
func withTestTunnelModes(t *testing.T, specs ...TunnelModeSpec) {
	t.Helper()
	saved, sealed := tunnelModeRegistry, tunnelModesSealed.Load()
	tunnelModeRegistry = nil
	tunnelModesSealed.Store(false)
	for _, spec := range specs {
		RegisterTunnelMode(spec)
	}
	t.Cleanup(func() {
		tunnelModeRegistry = saved
		tunnelModesSealed.Store(sealed)
	})
}

// TestTunnelRegistryDispatch verifies newTunnelProvider consults the registry:
// a registered mode gets its factory's provider (handed the host capability),
// an unknown mode errors, and an unavailable mode errors with its hint.
func TestTunnelRegistryDispatch(t *testing.T) {
	withTestTunnelModes(t,
		TunnelModeSpec{
			Mode: "fake",
			New: func(host TunnelHost) TunnelProvider {
				return &fakeTunnelProvider{mode: "fake", host: host, done: make(chan struct{})}
			},
		},
		TunnelModeSpec{
			Mode:            "gone",
			UnavailableHint: msg.New("install the gone helper"),
			Available:       func() bool { return false },
			New: func(host TunnelHost) TunnelProvider {
				return &fakeTunnelProvider{mode: "gone", host: host, done: make(chan struct{})}
			},
		},
	)
	s := &Server{}

	p, err := s.newTunnelProvider("fake")
	if err != nil {
		t.Fatalf("registered mode: unexpected error %v", err)
	}
	fake, ok := p.(*fakeTunnelProvider)
	if !ok {
		t.Fatalf("registered mode: got %T, want *fakeTunnelProvider", p)
	}
	if fake.host == nil {
		t.Fatal("factory must receive a non-nil TunnelHost")
	}

	if _, err := s.newTunnelProvider("bogus"); err == nil {
		t.Fatal("unknown mode should return an error")
	}

	if _, err := s.newTunnelProvider("gone"); err == nil {
		t.Fatal("unavailable mode should return an error")
	} else if want := "install the gone helper"; !strings.Contains(err.Error(), want) {
		t.Fatalf("unavailable error %q should contain the spec's hint %q", err, want)
	}
}

// TestWANModesPayloadCarriesMessages pins what GET /api/connectivity reports
// for each mode: the English in the plain keys an older client reads, and
// beside each the message it renders from, for a client to translate. A field
// the spec leaves empty sends no message.
func TestWANModesPayloadCarriesMessages(t *testing.T) {
	withTestTunnelModes(t, TunnelModeSpec{
		Mode:            "fake",
		Title:           msg.New("Fake tunnel"),
		Description:     msg.New("Tunnels through {via}.", "via", "nothing"),
		StartLabel:      msg.New("Start the fake tunnel"),
		UnavailableHint: msg.New("Requires the fake helper."),
		Available:       func() bool { return false },
		New:             func(TunnelHost) TunnelProvider { return nil },
	})

	raw, err := json.Marshal(wanModesPayload())
	if err != nil {
		t.Fatal(err)
	}
	var modes []map[string]any
	if err := json.Unmarshal(raw, &modes); err != nil {
		t.Fatal(err)
	}
	if len(modes) != 1 {
		t.Fatalf("got %d modes, want 1: %s", len(modes), raw)
	}
	m := modes[0]
	wantEnglish := map[string]string{
		"title":           "Fake tunnel",
		"description":     "Tunnels through nothing.",
		"startLabel":      "Start the fake tunnel",
		"relayNote":       "",
		"unavailableHint": "Requires the fake helper.",
	}
	for field, want := range wantEnglish {
		if got := m[field]; got != want {
			t.Errorf("%s = %#v, want %q", field, got, want)
		}
	}
	wantKeys := map[string]string{
		"titleMessage":           "Fake tunnel",
		"descriptionMessage":     "Tunnels through {via}.",
		"startLabelMessage":      "Start the fake tunnel",
		"unavailableHintMessage": "Requires the fake helper.",
	}
	for field, want := range wantKeys {
		message, _ := m[field].(map[string]any)
		if message == nil || message["key"] != want {
			t.Errorf("%s = %#v, want a message keyed %q", field, m[field], want)
		}
	}
	if params, _ := m["descriptionMessage"].(map[string]any)["params"].(map[string]any); params["via"] != "nothing" {
		t.Errorf("descriptionMessage params = %#v, want via=nothing", m["descriptionMessage"])
	}
	if _, ok := m["relayNoteMessage"]; ok {
		t.Errorf("an empty relayNote must send no message: %s", raw)
	}
	if m["available"] != false || m["mode"] != "fake" {
		t.Errorf("mode/available = %#v/%#v", m["mode"], m["available"])
	}
}

// TestRegisterTunnelModeValidation verifies invalid and duplicate registrations
// fail loudly at startup rather than being silently accepted.
func TestRegisterTunnelModeValidation(t *testing.T) {
	withTestTunnelModes(t)

	mustPanic := func(name string, fn func()) {
		t.Helper()
		defer func() {
			if recover() == nil {
				t.Fatalf("%s: expected panic", name)
			}
		}()
		fn()
	}

	mustPanic("missing mode", func() {
		RegisterTunnelMode(TunnelModeSpec{New: func(TunnelHost) TunnelProvider { return nil }})
	})
	mustPanic("missing factory", func() {
		RegisterTunnelMode(TunnelModeSpec{Mode: "x"})
	})

	RegisterTunnelMode(TunnelModeSpec{Mode: "x", New: func(TunnelHost) TunnelProvider { return nil }})
	mustPanic("duplicate mode", func() {
		RegisterTunnelMode(TunnelModeSpec{Mode: "x", New: func(TunnelHost) TunnelProvider { return nil }})
	})
}

// TestRegisterTunnelModeAfterSealPanics: the registry is read without a lock
// once a server exists, so a registration after that is refused loudly rather
// than racing the readers. New seals it.
func TestRegisterTunnelModeAfterSealPanics(t *testing.T) {
	withTestTunnelModes(t)
	RegisterTunnelMode(TunnelModeSpec{Mode: "early", New: func(TunnelHost) TunnelProvider { return nil }})

	sealTunnelModes()
	defer func() {
		if recover() == nil {
			t.Fatal("a registration after the seal was accepted")
		}
		if _, ok := findTunnelMode("late"); ok {
			t.Fatal("a refused registration still landed in the registry")
		}
	}()
	RegisterTunnelMode(TunnelModeSpec{Mode: "late", New: func(TunnelHost) TunnelProvider { return nil }})
}
