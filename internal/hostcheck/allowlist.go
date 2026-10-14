//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package hostcheck

import (
	"fmt"
	"net"
	"net/netip"
	"slices"
	"strings"
)

// AllowList is the set of extra Host names the user has told a server to
// accept on top of NamesThisMachine — typically the name a reverse proxy on
// this machine (tailscale serve, caddy, nginx) publishes it under. Naming a
// public DNS name here is safe only because the user controls what that name
// resolves to: a rebinding attacker would need to point it at this machine,
// which takes control of its DNS. So entries are exact names, never patterns —
// a wildcard would hand the whole zone, including names someone else may own,
// past the rebinding defence. The zero value allows nothing.
type AllowList struct {
	names map[string]bool
}

// NewAllowList builds an AllowList from user-supplied names, folded to lower
// case. An entry that is not one plain DNS name — a wildcard, an address, a
// name with a port, scheme or path, a trailing dot — is an error naming it,
// since accepting it silently would leave the user's proxy refused for a
// reason they cannot see.
func NewAllowList(names []string) (AllowList, error) {
	a := AllowList{names: map[string]bool{}}
	for _, raw := range names {
		name := strings.ToLower(strings.TrimSpace(raw))
		if _, err := netip.ParseAddr(name); err == nil {
			return AllowList{}, fmt.Errorf("allowed host %q is an address; addresses are always accepted, so give a DNS name", raw)
		}
		if !isHostname(name) {
			return AllowList{}, fmt.Errorf("allowed host %q is not a DNS name (give the bare name: no scheme, port, path or wildcard)", raw)
		}
		a.names[name] = true
	}
	return a, nil
}

// Has reports whether a Host header value (with or without a port) is one of
// the allowed names, ignoring case.
func (a AllowList) Has(host string) bool {
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	return a.names[strings.ToLower(host)]
}

// Names returns the allowed names, sorted.
func (a AllowList) Names() []string {
	out := make([]string, 0, len(a.names))
	for n := range a.names {
		out = append(out, n)
	}
	slices.Sort(out)
	return out
}
