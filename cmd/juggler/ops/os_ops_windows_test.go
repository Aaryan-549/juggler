//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build windows

package ops

import (
	"path/filepath"
	"strings"
	"testing"
)

// A file named R&D.txt holds no space, so Go would hand it to cmd.exe unquoted
// and cmd would run "D.txt". The open command must not involve cmd at all.
func TestOpenCmdNeverGoesThroughCmd(t *testing.T) {
	path := `C:\work\R&D.txt`
	cmds := newOpenCmds(path)
	if len(cmds) != 1 {
		t.Fatalf("want one command, got %d", len(cmds))
	}
	args := cmds[0].Args
	if base := strings.ToLower(filepath.Base(cmds[0].Path)); base == "cmd.exe" || base == "cmd" {
		t.Fatalf("open runs %s: %q", cmds[0].Path, args)
	}
	if args[len(args)-1] != path {
		t.Fatalf("the path must be the last argument, whole: %q", args)
	}
}
