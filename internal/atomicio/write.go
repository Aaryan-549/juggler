//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package atomicio

import (
	"os"
	"path/filepath"
)

// WriteFile writes data to path the way os.WriteFile does, except that no
// reader, crash or racing writer can ever see a partial file: the bytes go to a
// temp file of their own in the same directory, are synced to disk, and are then
// published over path with RobustRename. Whatever path holds afterwards is one
// complete write — the old file or the new one, never a torn mix — and when two
// writers race, the last rename wins whole.
//
// perm is the file's mode exactly, with no umask applied, whether path existed
// or not. Use 0600 for anything that can hold a secret.
//
// The directory must exist. On failure path is untouched and the temp file is
// removed.
func WriteFile(path string, data []byte, perm os.FileMode) (err error) {
	dir, base := filepath.Split(path)
	if dir == "" {
		dir = "."
	}
	// Each write gets its own temp (a shared name would itself collide between
	// racing writers), dot-prefixed so a directory listing never mistakes it
	// for the real file.
	tmp, err := os.CreateTemp(dir, "."+base+".*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() {
		if err != nil {
			_ = tmp.Close()
			_ = os.Remove(tmpName)
		}
	}()

	if err = tmp.Chmod(perm); err != nil {
		return err
	}
	if _, err = tmp.Write(data); err != nil {
		return err
	}
	// Synced before the rename, or a crash just after it could publish a name
	// whose data blocks never reached the disk.
	if err = tmp.Sync(); err != nil {
		return err
	}
	if err = tmp.Close(); err != nil {
		return err
	}
	return RobustRename(tmpName, path)
}
