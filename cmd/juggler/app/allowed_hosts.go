//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

import (
	"errors"

	"juggler/cmd/juggler/core"
	"juggler/internal/hostcheck"
	"juggler/internal/jlog"
)

// resolveAllowedHosts is the server's allowed-host list: the saved
// connectivity.allowedHosts plus every --allow-host. The setting applies to
// every launch, terminal included, except two. Test mode never reads a
// developer's real settings.json. A session child is reached only through its
// machine server, which holds the list and vouches for proxied callers, so it
// takes none, and refuses the flag rather than accept a list that could never
// apply.
func (a *App) resolveAllowedHosts() (hostcheck.AllowList, error) {
	if a.flags.sessionChild {
		if len(a.flags.allowHosts) > 0 {
			return hostcheck.AllowList{}, errors.New("--allow-host belongs on the machine server (`juggler serve`), not a session child")
		}
		return hostcheck.AllowList{}, nil
	}
	var setting []string
	if !a.flags.testMode {
		gs, err := core.LoadGlobalSettings()
		if err != nil {
			jlog.Error("Allowed hosts: settings load failed, using --allow-host only: %v", err)
		}
		setting = gs.Connectivity.AllowedHosts
	}
	allowed, warnings, err := core.ResolveAllowedHosts(setting, a.flags.allowHosts)
	for _, w := range warnings {
		jlog.Error("%s", w)
	}
	return allowed, err
}
