//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"fmt"
	"time"

	"juggler/internal/jlog"
)

// restartPolicy governs respawning a session child that crashed. The zero
// value means defaultRestartPolicy.
type restartPolicy struct {
	// base is the delay before the first restart; each further crash in a
	// row doubles it, up to max.
	base, max time.Duration
	// limit is how many restarts in a row are attempted. The crash after the
	// last of them gives the session up (SessionError).
	limit int
	// stable is how long a child must run for its crash to start a fresh
	// count, rather than continue the one that led to it.
	stable time.Duration
}

var defaultRestartPolicy = restartPolicy{base: time.Second, max: 30 * time.Second, limit: 5, stable: 5 * time.Minute}

func (p restartPolicy) orDefault() restartPolicy {
	if p == (restartPolicy{}) {
		return defaultRestartPolicy
	}
	return p
}

// delay is the wait before the n-th restart in a row (n from 1).
func (p restartPolicy) delay(n int) time.Duration {
	d := p.base
	for i := 1; i < n && d < p.max; i++ {
		d *= 2
	}
	return min(d, p.max)
}

// startSupervising hands a freshly running child to its session's supervisor.
// The count is taken here, before the goroutine starts, so it is never seen at
// zero while a supervisor is about to run.
func (s *Server) startSupervising(id string, c *child) {
	s.supervising.Add(1)
	go s.supervise(id, c)
}

// supervise watches a session's child for as long as the session is its to
// watch, polling its activity while it runs.
//
//   - A clean exit (status 0) is a deliberate shutdown — the child's own
//     shutdown route, or a standalone server taking the project with
//     --kill-existing — so the session goes. Restarting it would fight that
//     server for the project lock.
//   - A crash (any other status, or a signal) turns the session to restarting
//     and respawns its project under the same ID after restartPolicy.delay,
//     so the /s/<id>/ a user holds keeps working. A respawn that fails counts
//     as another crash.
//   - Past restartPolicy.limit crashes in a row, the session is given up and
//     turns to error.
//
// A stop or shutdown that claims the session ends supervision: every registry
// transition here applies only while the session is still this child's (see
// sessionEntry.owned), and beginRestart fails once a stop has removed it
// during the backoff.
func (s *Server) supervise(id string, c *child) {
	defer s.supervising.Add(-1)
	p := s.restart.orDefault()
	crashes := 0
	for {
		started := time.Now()
		go s.pollActivity(id, c, activityPollInterval)
		<-c.exited
		if c.exitedCleanly() {
			if s.reg.removeOwned(id, c) {
				jlog.Info("[machineserver] session %s: child exited cleanly; session ended", id)
			}
			return
		}
		if time.Since(started) >= p.stable {
			crashes = 0
		}
		reason := c.exitReason()
		var next *child
		for next == nil {
			crashes++
			if crashes > p.limit {
				jlog.Error("[machineserver] session %s: giving up after %d crashes: %s", id, crashes, reason)
				s.reg.failOwned(id, c, fmt.Sprintf("session child crashed %d times in a row; last: %s", crashes, reason))
				return
			}
			wait := p.delay(crashes)
			if !s.reg.setRestarting(id, c, reason, time.Now().Add(wait)) {
				return
			}
			jlog.Error("[machineserver] session %s: %s; restarting in %s", id, reason, wait)
			c = nil
			time.Sleep(wait)
			project, ok := s.reg.beginRestart(id)
			if !ok {
				return
			}
			spawned, err := spawnChild(s.childBin, project, s.childExtraArgs(id))
			if err != nil {
				reason = err.Error()
				continue
			}
			if !s.reg.setRunning(id, spawned, spawned.cmd.Process.Pid) {
				spawned.stop()
				return
			}
			jlog.Info("[machineserver] session %s: restarted at %s (pid %d)", id, spawned.addr, spawned.cmd.Process.Pid)
			next = spawned
		}
		c = next
	}
}
