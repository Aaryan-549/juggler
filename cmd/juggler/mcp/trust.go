//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package mcp

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"

	"juggler/internal/atomicio"
	"juggler/internal/userpaths"
)

// A project's .juggler/mcp.json can arrive with a cloned repository, and a stdio
// entry in it is a command line. So a project stdio server starts only once the
// user has trusted that exact command: its fingerprint — project, server name,
// command, args and env — is recorded in <ConfigDir>/mcp-trust.json, which no
// repository can write. Changing any of those makes it a different command, and
// it waits to be trusted again. Remote (http/sse) entries run nothing locally and
// global entries are the user's own, so neither is gated.

// trustFileName is the trust store's filename under the config dir.
const trustFileName = "mcp-trust.json"

// trustSlot serialises read-modify-write of the trust store within this
// process: a writer holds the one slot for the duration.
var trustSlot = make(chan struct{}, 1)

type trustStore struct {
	Trusted []string `json:"trusted"`
}

func trustPath() string {
	return filepath.Join(userpaths.ConfigDir(), trustFileName)
}

// needsTrust reports whether a project entry runs a local command.
func needsTrust(sc ServerConfig) bool {
	return sc.transportKind() == "stdio"
}

// trustFingerprint identifies one project server's command line. JSON encoding
// sorts map keys, so the same env always hashes the same.
func trustFingerprint(projectRoot, name string, sc ServerConfig) string {
	data, _ := json.Marshal(struct {
		Project string            `json:"project"`
		Name    string            `json:"name"`
		Command string            `json:"command"`
		Args    []string          `json:"args"`
		Env     map[string]string `json:"env"`
	}{filepath.Clean(projectRoot), name, sc.Command, sc.Args, sc.Env})
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// readTrusted returns the trusted fingerprints. A missing or unreadable store
// trusts nothing.
func readTrusted() map[string]bool {
	out := map[string]bool{}
	data, err := os.ReadFile(trustPath())
	if err != nil {
		return out
	}
	var store trustStore
	if json.Unmarshal(data, &store) != nil {
		return out
	}
	for _, fp := range store.Trusted {
		out[fp] = true
	}
	return out
}

// addTrusted records fingerprints in the store.
func addTrusted(fingerprints ...string) error {
	if len(fingerprints) == 0 {
		return nil
	}
	trustSlot <- struct{}{}
	defer func() { <-trustSlot }()
	have := readTrusted()
	var store trustStore
	for fp := range have {
		store.Trusted = append(store.Trusted, fp)
	}
	for _, fp := range fingerprints {
		if !have[fp] {
			store.Trusted = append(store.Trusted, fp)
			have[fp] = true
		}
	}
	slices.Sort(store.Trusted)
	data, err := json.MarshalIndent(store, "", "  ")
	if err != nil {
		return err
	}
	return writePrivateFile(trustPath(), append(data, '\n'))
}

// trustProjectServer trusts the project server name as its config stands now.
func trustProjectServer(projectRoot, name string) error {
	if projectRoot == "" {
		return fmt.Errorf("no project loaded")
	}
	cfg, err := readConfigFile(projectConfigPath(projectRoot))
	if err != nil {
		return err
	}
	sc, ok := cfg.Servers[name]
	if !ok {
		return fmt.Errorf("no project mcp server named %q", name)
	}
	if !needsTrust(sc) {
		return nil
	}
	return addTrusted(trustFingerprint(projectRoot, name, sc))
}

// trustAuthored trusts the project entries in next whose command differs from
// prev — the ones the user has just written, so has seen. An entry carried over
// unchanged is not trusted by being saved alongside an edit to another one: the
// settings UI writes the whole map on every change.
func trustAuthored(projectRoot string, prev, next map[string]ServerConfig) error {
	var fps []string
	for name, sc := range next {
		if !needsTrust(sc) {
			continue
		}
		fp := trustFingerprint(projectRoot, name, sc)
		if old, ok := prev[name]; ok && needsTrust(old) && trustFingerprint(projectRoot, name, old) == fp {
			continue
		}
		fps = append(fps, fp)
	}
	return addTrusted(fps...)
}

// writePrivateFile writes data to path readable by the owner only, publishing
// it with an atomic rename so a reader never sees a partial file.
func writePrivateFile(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, filepath.Base(path)+"-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }() // no-op once the rename succeeds
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return atomicio.RobustRename(tmpName, path)
}
