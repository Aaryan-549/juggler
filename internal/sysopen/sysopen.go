//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package sysopen builds the command that hands a URL or path to the operating
// system's default handler.
package sysopen

import (
	"os"
	"strings"
)

// Argv returns the program and arguments that open target with its default
// handler on goos. The target is always the last argument, whole.
//
// On Windows that rules out cmd.exe. Go quotes an argument only when it holds a
// space, tab or quote, so `cmd /c start "" <target>` hands cmd "&", "|" and "^"
// bare: a URL such as https://x/?a=1&calc runs calc, and a file named R&D.txt
// runs D.txt. url.dll's FileProtocolHandler takes its argument verbatim and
// passes it to the shell's default "open" — the same association `start` used,
// with nothing parsed on the way. It is named by its full System32 path so that
// no rundll32.exe elsewhere on the search path can stand in for it. It exits 0
// whether or not anything opened; where nothing is associated, Windows asks the
// user itself.
func Argv(goos, target string) []string {
	switch goos {
	case "darwin":
		return []string{"open", target}
	case "windows":
		return []string{windowsRundll32(), "url.dll,FileProtocolHandler", target}
	default:
		return []string{"xdg-open", target}
	}
}

// windowsRundll32 is rundll32.exe in the Windows system directory.
func windowsRundll32() string {
	root := os.Getenv("SYSTEMROOT")
	if root == "" {
		root = `C:\Windows`
	}
	return strings.TrimRight(root, `\/`) + `\System32\rundll32.exe`
}
