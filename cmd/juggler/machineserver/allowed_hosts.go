//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"juggler/cmd/juggler/core"
	"juggler/internal/hostcheck"
	"juggler/internal/jlog"
)

// resolveAllowedHosts is the machine server's allowed-host list: the saved
// connectivity.allowedHosts plus every --allow-host. The setting is what lets
// a server started implicitly, with no flags of its own, keep a reverse proxy
// working. Under --test it is not read, so the harness never picks up a
// developer's real settings.json.
func resolveAllowedHosts(flags []string, testChildren bool) (hostcheck.AllowList, error) {
	var setting []string
	if !testChildren {
		gs, err := core.LoadGlobalSettings()
		if err != nil {
			jlog.Error("serve: settings load failed, using --allow-host only: %v", err)
		}
		setting = gs.Connectivity.AllowedHosts
	}
	allowed, warnings, err := core.ResolveAllowedHosts(setting, flags)
	for _, w := range warnings {
		jlog.Error("serve: %s", w)
	}
	return allowed, err
}
