//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build windows

package ops

import (
	"os/exec"

	"juggler/internal/sysopen"
)

// newOpenCmds opens a path with its default Windows handler, passed whole and
// never through cmd.exe, which would run whatever follows an "&" in a file name
// (see sysopen.Argv).
func newOpenCmds(path string) []*exec.Cmd {
	argv := sysopen.Argv("windows", path)
	return []*exec.Cmd{exec.Command(argv[0], argv[1:]...)} //nolint:gosec // one argument, no shell
}

// newRevealCmds selects a path in Explorer. One way to ask, because Windows has
// one file manager.
func newRevealCmds(path string) []*exec.Cmd {
	return []*exec.Cmd{exec.Command("explorer", "/select,"+path)}
}

// exitStatusMeansFailure reports whether the launcher's exit status is worth
// believing.
//
// Not for a reveal: `explorer` returns a non-zero status as a matter of course,
// having done exactly what was asked, so reading it would report every
// successful reveal as a failure. The opener exits 0 whatever happens, so its
// status is believed only in the sense that it never claims a failure; where no
// association exists, Windows asks the user itself.
func exitStatusMeansFailure(reveal bool) bool {
	return !reveal
}
