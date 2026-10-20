//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"net"
	"strconv"
	"testing"
	"time"
)

// spawnFake starts a fake server for a fresh project and fails the test when it
// does not come up. It is stopped when the test ends, if nothing else did.
func spawnFake(t *testing.T) *serverProc {
	t.Helper()
	_, proc, err := spawnServer(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		// exited, never ProcessState: the waiting goroutine writes that until
		// exited closes.
		select {
		case <-proc.exited:
		default:
			_ = proc.cmd.Process.Kill()
			<-proc.exited
		}
	})
	return proc
}

// exitedCleanly fails the test unless p has exited of its own accord — a
// process the app had to kill reports no exit status of its own.
func exitedCleanly(t *testing.T, p *serverProc) {
	t.Helper()
	if st := p.cmd.ProcessState; st == nil || st.ExitCode() != 0 {
		t.Errorf("the server did not exit by itself (%v): it was killed, and lost whatever it had in flight", st)
	}
}

// A server is stopped by asking it to shut down, which is what lets it write
// its conversations to disk first. A signal cannot be that request everywhere:
// Windows has no way to deliver an interrupt to another process, so a stop that
// relied on one killed every server there outright. The request goes over
// HTTP, which every platform has, so this test exercises on every platform the
// path Windows depends on.
func TestStoppingAServerAsksItToShutDownOverHTTP(t *testing.T) {
	useFakeServer(t)
	t.Setenv(fakeServerDeafEnv, "1")
	proc := spawnFake(t)

	start := time.Now()
	proc.stop()

	exitedCleanly(t, proc)
	if took := time.Since(start); took >= serverStopGrace {
		t.Errorf("stopping took %s: the server was waited out rather than asked", took)
	}
}

// The request has to reach the server that was spawned. For a project, that is
// the record the server wrote under the project's lock — what anything else
// that asks a server to go reads, and what carries whatever the server needs to
// believe the request — and only when it names this process.
func TestTheShutdownRequestUsesTheServersOwnInstanceRecord(t *testing.T) {
	useFakeServer(t)
	proc := spawnFake(t)

	info := proc.shutdownInfo()
	if info == nil {
		t.Fatal("no instance to ask")
	}
	if info.PID != proc.cmd.Process.Pid {
		t.Errorf("asked pid %d, the spawned server is %d", info.PID, proc.cmd.Process.Pid)
	}
	if info.StartedAt.IsZero() {
		t.Error("the request was built from the address alone, not the record the server wrote for its project")
	}
	if got := net.JoinHostPort(info.Host, strconv.Itoa(info.Port)); got != proc.addr {
		t.Errorf("asked %s, the server is at %s", got, proc.addr)
	}
}

// A server with no project has no record on disk; the address it reported is
// enough to reach it.
func TestTheShutdownRequestForAServerWithNoProjectGoesToItsAddress(t *testing.T) {
	p := &serverProc{addr: "127.0.0.1:4141"}
	info := p.shutdownInfo()
	if info == nil || info.Host != "127.0.0.1" || info.Port != 4141 {
		t.Errorf("shutdownInfo() = %+v, want 127.0.0.1:4141", info)
	}
}

// Quitting stops every server the app spawned. Each may take a while to finish
// an exchange it has in flight, and the registry must not be held for any of
// that: every window operation waits on it, so a quit with several busy servers
// would freeze the app for the sum of their shutdowns. The servers are stopped
// side by side, so the quit costs the slowest of them rather than all of them
// in turn.
func TestStopAllServersStopsThemTogetherWithoutHoldingTheRegistry(t *testing.T) {
	const exitDelay = 3 * time.Second
	useFakeServer(t)
	t.Setenv(fakeServerDeafEnv, "1")
	t.Setenv(fakeServerExitDelayEnv, exitDelay.String())
	a := newTestAppState(t)
	procs := []*serverProc{spawnFake(t), spawnFake(t)}
	for _, p := range procs {
		a.reg(func(st *regState) { st.servers["http://"+p.addr] = p })
	}

	start := time.Now()
	stopped := make(chan struct{})
	go func() {
		a.stopAllServers()
		close(stopped)
	}()

	time.Sleep(200 * time.Millisecond)
	answered := make(chan struct{})
	go func() {
		a.reg(func(*regState) {})
		close(answered)
	}()
	select {
	case <-answered:
	case <-time.After(exitDelay - 500*time.Millisecond):
		t.Fatal("the registry did not answer while servers were being stopped")
	}

	select {
	case <-stopped:
	case <-time.After(serverStopGrace + 5*time.Second):
		t.Fatal("stopAllServers never returned")
	}
	if took := time.Since(start); took >= time.Duration(len(procs))*exitDelay {
		t.Errorf("stopping %d servers that each take %s took %s: they were stopped one after another", len(procs), exitDelay, took)
	}
	for _, p := range procs {
		exitedCleanly(t, p)
	}
	var left int
	a.reg(func(st *regState) { left = len(st.servers) })
	if left != 0 {
		t.Errorf("%d servers still recorded after stopAllServers", left)
	}
}
