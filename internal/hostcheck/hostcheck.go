//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package hostcheck is the DNS-rebinding defence's one rule: which Host header
// values may reach this server. A rebinding attacker points a domain they
// control at this machine's address, so the victim's browser sends that domain
// as Host — and, being same-origin with itself, as Origin too, which is why an
// Origin check alone does not stop it. What such a page cannot forge is a Host
// that is not a publicly registrable name, because it never gets to choose
// what the victim's own resolver answers for one.
//
// Both the per-project server (its /api surface) and the machine server
// (everything it serves) apply it, so it is spelled here once.
package hostcheck

import (
	"net"
	"net/netip"
	"strings"
)

// privateSuffixes are the special-use domains no public registry delegates, so
// a name under one is answered only by the user's own network: .local (mDNS,
// RFC 6762), .internal (reserved by ICANN for private use), .home.arpa (RFC
// 8375), and .lan, which home routers hand out by convention and which is not
// a delegated TLD.
var privateSuffixes = []string{".local", ".internal", ".home.arpa", ".lan"}

// NamesThisMachine reports whether a Host header value (with or without a port)
// is one a rebinding page cannot have sent: an IP address literal, "localhost"
// or a name under .localhost, a single-label name such as "juggler", or a name
// under one of privateSuffixes. Those cover reaching the server by address and
// by any name the user's own network gives it. Any other DNS name is publicly
// registrable and is refused.
func NamesThisMachine(host string) bool {
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	// netip.ParseAddr (unlike net.ParseIP) accepts a zoned IPv6 literal such as
	// fe80::1%en0 — the form a same-subnet client sends over a link-local
	// address. It is parsed before folding because a zone such as %en0 is
	// case-sensitive.
	if _, err := netip.ParseAddr(host); err == nil {
		return true
	}
	name := strings.ToLower(host)
	if !isHostname(name) {
		return false
	}
	// RFC 6761 reserves .localhost and requires it to resolve to loopback, so a
	// per-instance hostname like myproject.localhost names this machine.
	if name == "localhost" || strings.HasSuffix(name, ".localhost") {
		return true
	}
	// A single label is resolved through the user's own search domain or hosts
	// file; no public registry can make the victim's resolver answer for it.
	if !strings.Contains(name, ".") {
		return true
	}
	for _, suffix := range privateSuffixes {
		if strings.HasSuffix(name, suffix) {
			return true
		}
	}
	return false
}

// isHostname reports whether name is a plain LDH hostname: dot-separated,
// non-empty labels of letters, digits and hyphens. That excludes a trailing
// dot, which makes a single label absolute and so a top-level domain, and
// anything else a Host header might carry that is not a name at all.
func isHostname(name string) bool {
	if name == "" {
		return false
	}
	for label := range strings.SplitSeq(name, ".") {
		if label == "" {
			return false
		}
		for _, c := range label {
			if (c < 'a' || c > 'z') && (c < '0' || c > '9') && c != '-' {
				return false
			}
		}
	}
	return true
}
