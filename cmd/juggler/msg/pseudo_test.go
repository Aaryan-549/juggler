//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package msg

import (
	"encoding/json"
	"os"
	"testing"
)

// pseudoFixture is shared with the JS half (unit:i18n-pseudo-parity), which
// runs the same cases through the SDK's pseudoLocalize().
const pseudoFixture = "../../../web/js-tests/fixtures/i18n-pseudo-parity.json"

// TestPseudoParity holds PseudoLocalize to the SDK's pseudoLocalize(), so an
// en-XA.json written by `juggler ext i18n` matches one written by scripts/i18n.
func TestPseudoParity(t *testing.T) {
	data, err := os.ReadFile(pseudoFixture)
	if err != nil {
		t.Fatalf("read %s: %v", pseudoFixture, err)
	}
	var cases []struct {
		Name     string `json:"name"`
		Message  string `json:"message"`
		Expected string `json:"expected"`
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatalf("parse %s: %v", pseudoFixture, err)
	}
	if len(cases) == 0 {
		t.Fatal("the pseudo fixture is empty")
	}
	for _, c := range cases {
		if got := PseudoLocalize(c.Message); got != c.Expected {
			t.Errorf("%s: PseudoLocalize(%q) = %q, want %q", c.Name, c.Message, got, c.Expected)
		}
	}
}
