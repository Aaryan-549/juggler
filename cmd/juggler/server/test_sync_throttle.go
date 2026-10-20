//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package server

import (
	"os"
	"strconv"
	"time"
)

// testSyncThrottle is the outbound-sync window JUGGLER_TEST_SYNC_THROTTLE_MS
// asks for, if it names a positive number of milliseconds. The integration
// harness passes it through to widen the window, so a fast turn's busy→idle
// edge always merges into one broadcast — a knob for surfacing waits that
// depend on a transient state edge rather than the durable turn fence. A
// production build ignores it (test_sync_throttle_production.go).
func testSyncThrottle() (time.Duration, bool) {
	v := os.Getenv("JUGGLER_TEST_SYNC_THROTTLE_MS")
	if v == "" {
		return 0, false
	}
	ms, err := strconv.Atoi(v)
	if err != nil || ms <= 0 {
		return 0, false
	}
	return time.Duration(ms) * time.Millisecond, true
}
