//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"bytes"
	"fmt"
	"os"
	"runtime"
	"testing"
)

// TestMain checks, before any test has touched the package, that importing it
// started nothing: every binary that links ops — the server, the desktop app,
// every test binary — would otherwise carry the background-shell registry's
// goroutine whether it ever runs a shell or not.
func TestMain(m *testing.M) {
	buf := make([]byte, 1<<20)
	if stacks := buf[:runtime.Stack(buf, true)]; bytes.Contains(stacks, []byte("ops.runShellRegistry")) {
		fmt.Fprintln(os.Stderr, "FAIL: importing ops started the shell registry goroutine; it must start on first use")
		os.Exit(1)
	}
	os.Exit(m.Run())
}
