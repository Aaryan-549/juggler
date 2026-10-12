//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package logpaths

import (
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// FileInfo describes one log file on disk, as the Logs settings page lists it.
type FileInfo struct {
	Name     string `json:"name"`     // bare filename, e.g. "server.log"
	Path     string `json:"path"`     // absolute path (for the copy / reveal controls)
	Group    string `json:"group"`    // "server" | "conversations" | "app"
	Size     int64  `json:"size"`     // bytes
	Modified int64  `json:"modified"` // unix millis of last write
}

// Window is one contiguous slice of a log file, plus what a reader needs to
// keep tailing it.
type Window struct {
	Path     string `json:"path"`
	From     int64  `json:"from"`     // byte offset the returned content starts at
	Size     int64  `json:"size"`     // end offset of the content — the reader's next offset
	Content  string `json:"content"`  // bytes [From, Size)
	Replaced bool   `json:"replaced"` // true when this window does not continue the requested offset (fresh tail / post-rotation reset), so the reader must replace rather than append
}

// SessionLogs gathers the log files a user would want for one project server's
// session: its own folder (server.log, server.stderr.log, and every
// per-conversation log) and the shared desktop app.log. Files that don't exist
// yet are skipped, so the list reflects what is actually on disk.
func SessionLogs(project string) []FileInfo {
	files := make([]FileInfo, 0, 4)

	files = appendFile(files, ServerLogPath(project), "server")
	files = appendFile(files, StderrLogPath(project), "server")

	convDir := conversationLogDir(project)
	if entries, err := os.ReadDir(convDir); err == nil {
		names := make([]string, 0, len(entries))
		for _, e := range entries {
			if !e.IsDir() && strings.HasSuffix(e.Name(), ".log") {
				names = append(names, e.Name())
			}
		}
		sort.Strings(names)
		for _, n := range names {
			files = appendFile(files, filepath.Join(convDir, n), "conversations")
		}
	}

	files = appendFile(files, AppLogPath(), "app")
	return files
}

// appendFile stats path and, when it is an existing regular file, appends a
// FileInfo for it. Missing files are skipped so the caller only ever surfaces
// logs that are actually on disk.
func appendFile(files []FileInfo, path, group string) []FileInfo {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return files
	}
	return append(files, FileInfo{
		Name:     filepath.Base(path),
		Path:     path,
		Group:    group,
		Size:     info.Size(),
		Modified: info.ModTime().UnixMilli(),
	})
}

// Resolve cleans raw and confirms it names an existing regular file inside
// LogDir. It is the gate for anything that serves log content: a path that
// lexically escapes LogDir (via "..") or is not a regular file is rejected, so a
// caller can never be handed an arbitrary file.
func Resolve(raw string) (string, bool) {
	if raw == "" {
		return "", false
	}
	abs, err := filepath.Abs(filepath.Clean(raw))
	if err != nil {
		return "", false
	}
	dir, err := filepath.Abs(LogDir())
	if err != nil {
		return "", false
	}
	rel, err := filepath.Rel(dir, abs)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return "", false
	}
	info, err := os.Stat(abs)
	if err != nil || !info.Mode().IsRegular() {
		return "", false
	}
	return abs, true
}

// ReadWindow returns the slice of the file at path from the caller's offset to
// EOF. It powers incremental tailing:
//
//   - Normal poll (0 < offset <= size): returns bytes [offset, size); Replaced
//     is false, so the reader appends them.
//   - First read (offset <= 0): returns the last maxInitial bytes (the whole
//     file when smaller); Replaced is true when the window was capped.
//   - Rotation/truncation (offset > size): the file shrank, so the caller's
//     offset is stale; resets to a fresh tail with Replaced true.
//
// Replaced is precisely "the returned window does not start where the caller
// asked", which is exactly when the reader must replace rather than append. The
// returned bytes are sliced to what was actually read, so a file shrinking
// mid-read (rotation between the stat and the read) never yields trailing NULs.
func ReadWindow(path string, offset, maxInitial int64) (Window, error) {
	f, err := os.Open(path)
	if err != nil {
		return Window{}, err
	}
	defer func() { _ = f.Close() }()

	info, err := f.Stat()
	if err != nil {
		return Window{}, err
	}
	size := info.Size()

	start := offset
	if start < 0 || start > size {
		start = 0 // stale offset (first read or rotation) — re-window from a tail
	}
	if start == 0 && size > maxInitial {
		start = size - maxInitial
	}

	buf := make([]byte, size-start)
	n := 0
	if len(buf) > 0 {
		n, err = f.ReadAt(buf, start)
		if err != nil && err != io.EOF {
			return Window{}, err
		}
	}

	return Window{
		Path:     path,
		From:     start,
		Size:     start + int64(n),
		Content:  string(buf[:n]),
		Replaced: start != offset,
	}, nil
}
