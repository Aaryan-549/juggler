//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"os"
	"strings"
	"unicode"
)

// UpdatesManagedByEnv names the package manager that installed this build, for
// a packager to set (Nix, Homebrew, a distro package). When it is set Juggler
// never replaces itself: the update check still runs, but a newer version is
// reported as something to get through that package manager, with no download
// or install offered. The --updates-managed-by flag sets it for the process and
// every server it spawns, which inherit it through the environment.
const UpdatesManagedByEnv = "JUGGLER_UPDATES_MANAGED_BY"

const (
	maxManagedByLen = 40 // runes of the name shown in the UI
	maxViaLen       = 32 // bytes of the slug sent with the update check
)

// UpdatesManagedBy returns the package manager's name as the UI shows it, or ""
// when this build updates itself. Control characters are dropped and the name
// is trimmed and capped, since it is shown verbatim.
func UpdatesManagedBy() string {
	raw := strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, os.Getenv(UpdatesManagedByEnv))
	name := []rune(strings.TrimSpace(raw))
	if len(name) > maxManagedByLen {
		name = name[:maxManagedByLen]
	}
	return strings.TrimSpace(string(name))
}

// UpdatesVia returns UpdatesManagedBy as the update check's via= value:
// lowercase ASCII letters and digits, each other run collapsed to one hyphen,
// trimmed and capped. "" when unmanaged, or when the name has no letters or
// digits to keep.
func UpdatesVia() string {
	var b strings.Builder
	pendingHyphen := false
	for _, r := range strings.ToLower(UpdatesManagedBy()) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			if pendingHyphen && b.Len() > 0 {
				b.WriteByte('-')
			}
			pendingHyphen = false
			b.WriteRune(r)
			continue
		}
		pendingHyphen = true
	}
	via := b.String()
	if len(via) > maxViaLen {
		via = strings.TrimRight(via[:maxViaLen], "-")
	}
	return via
}

// SetUpdatesManagedBy records name as the managing package manager for this
// process and, through the environment, for every server it spawns.
func SetUpdatesManagedBy(name string) error {
	return os.Setenv(UpdatesManagedByEnv, name)
}
