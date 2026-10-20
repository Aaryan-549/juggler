//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"net"
	"os"
	"os/exec"
	"strconv"
	"sync/atomic"
	"time"

	"juggler/cmd/juggler/core"
)

// A window views one server address for its whole life, and the page in it
// reconnects only ever to that address. So when a server this app spawned dies
// while windows still view it — a crash, or the server giving up because its
// engine never came up on a crowded login — nothing in the window can recover:
// it shows "Reconnecting" for as long as it stays open. The app is the only
// thing that can, by starting the project's server again on the same port. The
// page then reconnects to a server with a different boot id, and reloads itself
// onto it.
//
// The restart keeps a server's windows working; it does not keep a broken one
// running. One that dies again and again soon after starting is given up on
// (serverQuickDeaths), and one the app itself stopped is never restarted.

// serverProc is a server this app spawned, and so one it stops when nothing
// views it any more and starts again if it dies while something still does.
type serverProc struct {
	cmd     *exec.Cmd
	project string
	// addr is the host:port the server reported binding. Set before the proc is
	// handed out, and not written after.
	addr    string
	started time.Time
	// exited is closed once the process has exited and been reaped. It is the
	// only Wait on cmd.
	exited chan struct{}
	// stopping is set once the app has asked the server to go, which is what
	// tells an exit the app wanted from one it did not.
	stopping atomic.Bool
}

// newServerProc wraps a started server and waits on it for its whole life.
func newServerProc(cmd *exec.Cmd, project string) *serverProc {
	p := &serverProc{cmd: cmd, project: project, started: time.Now(), exited: make(chan struct{})}
	go func() {
		_ = cmd.Wait()
		close(p.exited)
	}()
	return p
}

// running reports whether p is a live process this app still waits on.
func (p *serverProc) running() bool {
	return p != nil && p.cmd != nil && p.cmd.Process != nil
}

// interrupt asks the server to exit without waiting for it. Used from the
// terminate hook, where the process is about to exit and can't block.
//
// The signal is instant where there is one to send. Windows cannot deliver an
// interrupt to another process, so there the shutdown request goes over HTTP
// instead, on a goroutine of its own: a local server acknowledges it within
// milliseconds, before the app's teardown reaches stopAllServers, which asks
// again and waits. A server neither reaches is caught by its own
// --exit-with-parent watchdog.
func (p *serverProc) interrupt() {
	if !p.running() {
		return
	}
	p.stopping.Store(true)
	if p.cmd.Process.Signal(os.Interrupt) != nil {
		go p.requestShutdown()
	}
}

// requestShutdown asks the server over HTTP to shut down the way an interrupt
// would have it — writing its conversations to disk before it goes — and
// reports whether it agreed to. It is the one request every platform can make.
func (p *serverProc) requestShutdown() bool {
	info := p.shutdownInfo()
	if info == nil {
		return false
	}
	ok, err := core.RequestGracefulShutdown(info)
	if err != nil {
		logf("asking the server for project=%q at %s to shut down: %v", p.project, p.addr, err)
	}
	return ok
}

// shutdownInfo is the instance a shutdown request for p goes to. For a project
// that is the record the server wrote under the project's lock, which is what
// every other caller of core.RequestGracefulShutdown reads and so carries
// whatever the server needs to believe the request — used only when it names
// this very process, since the lock may since have passed to another. A server
// with no project has no such record, and is reached at the address it
// reported. Nil when there is no address to reach.
func (p *serverProc) shutdownInfo() *core.InstanceInfo {
	host, port, err := net.SplitHostPort(p.addr)
	if err != nil {
		return nil
	}
	n, err := strconv.Atoi(port)
	if err != nil {
		return nil
	}
	pid := 0
	if p.running() {
		pid = p.cmd.Process.Pid
	}
	if abs := expandProject(p.project); abs != "" && pid != 0 {
		if locked, info, _ := core.CheckProjectLocked(abs); locked && info != nil && info.PID == pid && info.Port == n {
			return info
		}
	}
	return &core.InstanceInfo{PID: pid, Host: host, Port: n}
}

// stop asks the server to exit (the clean-close path: a window closed, or the
// app is quitting) and waits for it, force-killing it once serverStopGrace has
// passed since the ask.
//
// The ask is the HTTP shutdown request first, on every platform, so the path
// Windows depends on is the one every platform runs and tests. A server that
// does not acknowledge it — its HTTP side wedged, or nothing listening — is sent
// an interrupt instead, and only one that cannot be reached either way is
// killed at once rather than waited on for a request it never received. The
// crash/hard-kill path is covered separately by the server's own
// --exit-with-parent watchdog (waitParentExit).
func (p *serverProc) stop() {
	if !p.running() {
		return
	}
	p.stopping.Store(true)
	asked := p.requestShutdown() || p.cmd.Process.Signal(os.Interrupt) == nil
	if !asked {
		_ = p.cmd.Process.Kill()
		<-p.exited
		return
	}
	select {
	case <-p.exited:
	case <-time.After(serverStopGrace):
		logf("server for project=%q at %s did not exit within %s of being asked; killing it", p.project, p.addr, serverStopGrace)
		_ = p.cmd.Process.Kill()
		<-p.exited
	}
}

const (
	// serverHealthyUptime is how long a server must have run for its death to
	// count as a one-off rather than part of a crash loop.
	serverHealthyUptime = time.Minute
	// serverQuickDeaths is how many deaths in a row within serverHealthyUptime
	// of starting the app restarts a server through before giving up on it.
	serverQuickDeaths = 3
	// serverRestartAttempts bounds the tries at bringing up a replacement that
	// answers where the windows look.
	serverRestartAttempts = 4
)

// adoptServer records proc as the server this app spawned for serverURL, and
// watches it. A nil proc (a reused or remote server) records nothing, and so
// does a URL that already has one.
func (a *appState) adoptServer(serverURL string, proc *serverProc) {
	if proc == nil {
		return
	}
	adopted := false
	a.reg(func(st *regState) {
		if _, ok := st.servers[serverURL]; !ok {
			st.servers[serverURL] = proc
			adopted = true
		}
	})
	if adopted {
		go a.superviseServer(serverURL, proc)
	}
}

// superviseServer waits for the server at serverURL to exit, and starts it again
// each time it does so while windows still view it. Returns once the app has
// stopped the server, nothing views it, or it has been given up on.
func (a *appState) superviseServer(serverURL string, p *serverProc) {
	quick := 0
	for {
		<-p.exited
		if p.stopping.Load() {
			return
		}
		lived := time.Since(p.started)
		logf("server for project=%q at %s exited unexpectedly (%s) after %s",
			p.project, p.addr, p.cmd.ProcessState, lived.Round(time.Millisecond))
		if lived < serverHealthyUptime {
			quick++
		} else {
			quick = 0
		}
		if quick > serverQuickDeaths {
			logf("server for project=%q died %d times running within %s of starting; not starting it again — see its server.log",
				p.project, quick, serverHealthyUptime)
			a.releaseServer(serverURL, p)
			return
		}
		next := a.restartServer(serverURL, p)
		if next == nil {
			return
		}
		p = next
	}
}

// restartServer brings up a replacement for the dead server old, on the port its
// windows look at, and records it in old's place. Returns nil when there is no
// longer anything to restart it for, or no replacement could be brought up
// there.
func (a *appState) restartServer(serverURL string, old *serverProc) *serverProc {
	_, port, err := net.SplitHostPort(old.addr)
	if err != nil {
		logf("server for project=%q has no port to restart on (%q)", old.project, old.addr)
		a.releaseServer(serverURL, old)
		return nil
	}
	spawn := a.spawnServerOn
	if spawn == nil {
		spawn = spawnServerOn
	}
	for attempt := 1; attempt <= serverRestartAttempts; attempt++ {
		if !a.stillNeeded(serverURL, old, nil) {
			return nil
		}
		logf("starting the server for project=%q again on port %s", old.project, port)
		addr, next, err := spawn(old.project, port)
		switch {
		case err != nil:
			logf("restarting the server for project=%q failed: %v", old.project, err)
		case addr != old.addr:
			logf("restarted server for project=%q bound %s, not %s where its windows look; stopping it", old.project, addr, old.addr)
			next.stop()
		case a.stillNeeded(serverURL, old, next):
			return next
		default:
			next.stop()
			return nil
		}
		time.Sleep(time.Duration(attempt) * time.Second)
	}
	logf("could not start the server for project=%q again on port %s; giving up", old.project, port)
	a.releaseServer(serverURL, old)
	return nil
}

// stillNeeded reports whether old is still the server recorded for serverURL,
// the app is not quitting, and some window still views it. When it is and next
// is non-nil, next replaces old in the record — in the same registry step, so a
// window closing in between can't leave next running with nothing to stop it.
func (a *appState) stillNeeded(serverURL string, old, next *serverProc) bool {
	needed := false
	a.reg(func(st *regState) {
		if st.quitting || st.servers[serverURL] != old {
			return
		}
		for _, w := range st.windows {
			if w.serverURL == serverURL {
				needed = true
				break
			}
		}
		if needed && next != nil {
			st.servers[serverURL] = next
		}
	})
	return needed
}

// releaseServer forgets p as the server for serverURL, if it still is.
func (a *appState) releaseServer(serverURL string, p *serverProc) {
	a.reg(func(st *regState) {
		if st.servers[serverURL] == p {
			delete(st.servers, serverURL)
		}
	})
}
