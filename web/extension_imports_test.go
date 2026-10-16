//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package web

import (
	"io/fs"
	"path"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// relativeImport matches the specifier of a static import or re-export
// (`import x from '…'`, `import '…'`, `export … from '…'`) that is a relative
// path. JSDoc type references (`@type {import('…')}`) are not imports at
// runtime and are out of scope.
var relativeImport = regexp.MustCompile(`^\s*(?:import|export)\b[^'"]*?(?:from\s+)?['"](\.\.?/[^'"]+)['"]`)

// TestExtensionsReachCoreOnlyThroughSDK fails when a shipped extension imports
// the app's own js/ tree by relative path. Extensions reach the core only
// through the `juggler/*` SDK specifiers, which resolve in both the browser and
// the engine worker; a relative path into js/ ties the extension to the app's
// internal layout and crosses the Apache-2.0 / AGPL boundary.
//
// knownCoreImports lists the imports that predate this rule, each a
// "file imports specifier" pair. Nothing may be added to it; an entry whose
// import is gone fails too, so the list only shrinks.
func TestExtensionsReachCoreOnlyThroughSDK(t *testing.T) {
	knownCoreImports := map[string]bool{
		"extensions/juggler-core/cards/git-status-card.js imports ../../../js/services/git-status-cache.js":                        true,
		"extensions/juggler-core/cards/git-status-card.js imports ../../../js/services/pinboard-view.js":                           true,
		"extensions/juggler-core/cards/usage-card.js imports ../../../js/services/default-model-cache.js":                          true,
		"extensions/juggler-core/cards/usage-card.js imports ../../../js/services/providers-cache.js":                              true,
		"extensions/juggler-core/cards/usage-card.js imports ../../../js/services/usage-stats-cache.js":                            true,
		"extensions/juggler-core/cards/usage-card.js imports ../../../js/utils/usage-renderer.js":                                  true,
		"extensions/juggler-core/context-items/define-command-context-item.js imports ../../../js/services/user-commands.js":       true,
		"extensions/juggler-core/context-items/skill-context-item.js imports ../../../js/services/skills.js":                       true,
		"extensions/juggler-core/context-items/skill-context-item.js imports ../../../js/components/settings/skill-preview.js":     true,
		"extensions/juggler-core/context-items/subagents/subagent-item.js imports ../../../../js/registries/strategy-registry.js":  true,
		"extensions/juggler-core/context-items/system-prompt/preset-browser.js imports ../../../../js/utils/menu-roles.js":         true,
		"extensions/juggler-core/context-items/system-prompt-context-item.js imports ../../../js/utils/format.js":                  true,
		"extensions/juggler-core/strategies/auto-approve-strategy-type.js imports ../../../js/services/file-editing-permission.js": true,
		"extensions/juggler-core/workspaces/git-worktree-workspace-provider.js imports ../../../js/services/api.js":                true,
		"extensions/juggler-mcp/context-items/mcp-tool-context-item.js imports ../../../js/services/websocket.js":                  true,
	}
	seen := map[string]bool{}
	var offenders []string
	// A file whose name starts with "_" is not embedded, and neither is a
	// directory's, so the extension test files under _tests/ are not walked.
	err := fs.WalkDir(builtin, "extensions", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(p, ".js") {
			return err
		}
		src, err := builtin.ReadFile(p)
		if err != nil {
			return err
		}
		for i, line := range strings.Split(string(src), "\n") {
			m := relativeImport.FindStringSubmatch(line)
			if m == nil {
				continue
			}
			target := path.Clean(path.Join(path.Dir(p), m[1]))
			if !strings.HasPrefix(target, "js/") {
				continue
			}
			key := p + " imports " + m[1]
			if knownCoreImports[key] {
				seen[key] = true
				continue
			}
			offenders = append(offenders, p+":"+strconv.Itoa(i+1)+" imports "+m[1])
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk extensions: %v", err)
	}
	for _, o := range offenders {
		t.Errorf("extension reaches into js/ by relative path (use a juggler/* SDK specifier): %s", o)
	}
	for key := range knownCoreImports {
		if !seen[key] {
			t.Errorf("knownCoreImports entry no longer occurs; remove it: %s", key)
		}
	}
}
