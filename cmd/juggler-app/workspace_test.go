//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func workspacePath(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "config", "workspace.json")
}

// What one run saves, the next one reads back: the open windows in order, the
// last theme and the last zoom. Each is saved on its own, so saving one must
// keep the others.
func TestTheWorkspaceComesBackAsItWasSaved(t *testing.T) {
	path := workspacePath(t)
	w := newWorkspaceStoreAt(path)
	w.saveTheme("light")
	w.saveZoom(120)
	w.flush([]workspaceEntry{{Project: "/a"}, {Server: "http://remote:3000"}, {Project: ""}})

	next := newWorkspaceStoreAt(path)
	want := []windowSpec{{project: "/a"}, {url: "http://remote:3000", connected: true}, {}}
	if got := next.load(); !reflect.DeepEqual(got, want) {
		t.Errorf("load() = %+v, want %+v", got, want)
	}
	if got := next.loadLastTheme(); got != "light" {
		t.Errorf("loadLastTheme() = %q, want light", got)
	}
	if got := next.loadLastZoom(); got != 120 {
		t.Errorf("loadLastZoom() = %d, want 120", got)
	}

	// A later save of the windows alone leaves the theme and zoom as they were.
	next.flush([]workspaceEntry{{Project: "/b"}})
	f := readWorkspaceFile(path)
	if f.LastTheme != "light" || f.LastZoom != 120 || len(f.Windows) != 1 || f.Windows[0].Project != "/b" {
		t.Errorf("after a windows-only save the file holds %+v", f)
	}
}

// Nothing saved yet is an empty workspace, not an error.
func TestAMissingWorkspaceIsEmpty(t *testing.T) {
	w := newWorkspaceStoreAt(workspacePath(t))
	if got := w.load(); len(got) != 0 {
		t.Errorf("load() = %+v, want nothing", got)
	}
	if w.loadLastTheme() != "" || w.loadLastZoom() != 0 {
		t.Error("a missing workspace reported a theme or zoom")
	}
}

// The file is replaced whole rather than rewritten where it stands, so a write
// cut short — a crash, a full disk, power lost mid-quit — leaves the previous
// workspace rather than a torn one, which would read as no workspace at all.
func TestTheWorkspaceFileIsReplacedRatherThanRewritten(t *testing.T) {
	path := workspacePath(t)
	writeWorkspaceFile(path, workspaceFile{Windows: []workspaceEntry{{Project: "/a"}}})
	before, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	writeWorkspaceFile(path, workspaceFile{Windows: []workspaceEntry{{Project: "/b"}}})
	after, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if os.SameFile(before, after) {
		t.Error("the workspace file was rewritten in place; an interrupted write would tear it")
	}
	if got := readWorkspaceFile(path).Windows; len(got) != 1 || got[0].Project != "/b" {
		t.Errorf("read back %+v, want the second write", got)
	}
	entries, _ := os.ReadDir(filepath.Dir(path))
	if len(entries) != 1 {
		t.Errorf("the config directory holds %d entries, want only workspace.json: %v", len(entries), entries)
	}
}

// A workspace that cannot be read is not thrown away. The app starts with its
// default window either way, but the file is set aside where someone can find
// it, rather than overwritten by the next save.
func TestACorruptWorkspaceIsKeptAside(t *testing.T) {
	path := workspacePath(t)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	torn := []byte(`{"windows":[{"project":"/a"},{"proj`)
	if err := os.WriteFile(path, torn, 0o644); err != nil {
		t.Fatal(err)
	}

	if f := readWorkspaceFile(path); !reflect.DeepEqual(f, workspaceFile{}) {
		t.Errorf("a corrupt workspace read as %+v, want empty", f)
	}
	kept, err := os.ReadFile(path + ".corrupt")
	if err != nil {
		t.Fatalf("the corrupt workspace was not kept aside: %v", err)
	}
	if string(kept) != string(torn) {
		t.Errorf("kept %q, want the file as it was", kept)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Errorf("the corrupt file is still where the next save goes (stat: %v)", err)
	}
}
