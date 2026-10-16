//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package hostcheck

import (
	"fmt"
	"net"
	"strings"
)

// Refusal is the 403 body for a Host that neither NamesThisMachine nor the
// server's AllowList accepts. The browser shows it as the page, and the UI
// quotes it in its load error, so it is the user's only clue: it names the Host
// that was refused, says why such names are refused, lists the names accepted
// without configuration, and — when the Host is one --allow-host would take —
// gives the flag that admits it.
func Refusal(host string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Forbidden: host %q not allowed. To guard against DNS rebinding, "+
		"Juggler answers only to an IP address, localhost, a single-label name such as \"juggler\", "+
		"or a name under %s.", host, suffixList())
	name := host
	if h, _, err := net.SplitHostPort(host); err == nil {
		name = h
	}
	name = strings.ToLower(name)
	if isHostname(name) {
		fmt.Fprintf(&b, " To serve Juggler under this name, start it with --allow-host %s.", name)
	}
	return b.String()
}

// suffixList spells privateSuffixes as an English list: ".a, .b or .c".
func suffixList() string {
	n := len(privateSuffixes)
	if n == 1 {
		return privateSuffixes[0]
	}
	return strings.Join(privateSuffixes[:n-1], ", ") + " or " + privateSuffixes[n-1]
}
