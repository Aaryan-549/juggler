//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"fmt"

	"juggler/internal/hostcheck"
)

// ResolveAllowedHosts builds a server's allowed-host list from the saved
// setting (ConnectivitySettings.AllowedHosts) and its --allow-host flags,
// which add to it. The two sources fail differently on a bad name. A flag is
// an error: the user typed it at a terminal and is there to read why. A
// setting entry is skipped and returned as a warning instead, because the
// settings API refuses bad names, so one can only come from a hand edit, and a
// typo there must never stop a desktop launch that has nowhere to show the
// error.
func ResolveAllowedHosts(setting, flags []string) (hostcheck.AllowList, []string, error) {
	var warnings []string
	names := make([]string, 0, len(setting)+len(flags))
	for _, n := range setting {
		if _, err := hostcheck.NewAllowList([]string{n}); err != nil {
			warnings = append(warnings, fmt.Sprintf("settings connectivity.allowedHosts: %v; ignoring it", err))
			continue
		}
		names = append(names, n)
	}
	if _, err := hostcheck.NewAllowList(flags); err != nil {
		return hostcheck.AllowList{}, warnings, fmt.Errorf("--allow-host: %w", err)
	}
	a, err := hostcheck.NewAllowList(append(names, flags...))
	return a, warnings, err
}
