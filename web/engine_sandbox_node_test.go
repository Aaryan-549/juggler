//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package web

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// runNodeSandboxHarness runs body as an ES module in node, with
// `installNodeSandboxDelegate` and `runInSandbox` imported from the shipped
// files and the delegate already installed — the Node engine host's query_code
// path, minus the engine. body must print one JSON line last; it is decoded
// into out.
func runNodeSandboxHarness(t *testing.T, body string, out any) {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not found on PATH — skipping the Node sandbox host test")
	}
	moduleURL := func(rel string) string {
		p, err := filepath.Abs(rel)
		if err != nil {
			t.Fatalf("resolve %s: %v", rel, err)
		}
		u := url.URL{Scheme: "file", Path: filepath.ToSlash(p)}
		if !strings.HasPrefix(u.Path, "/") {
			u.Path = "/" + u.Path
		}
		b, _ := json.Marshal(u.String())
		return string(b)
	}
	script := fmt.Sprintf(`
import { installNodeSandboxDelegate } from %s;
import { runInSandbox } from %s;
installNodeSandboxDelegate({ origin: 'http://127.0.0.1:1', projectRoot: '/' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
%s
process.exit(0);
`, moduleURL("js/engine-sandbox-node.mjs"), moduleURL("sdk/lib/sandbox-runner.js"), body)
	harness := filepath.Join(t.TempDir(), "harness.mjs")
	if err := os.WriteFile(harness, []byte(script), 0o600); err != nil {
		t.Fatalf("write harness: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	raw, err := exec.CommandContext(ctx, node, harness).CombinedOutput()
	if err != nil {
		t.Fatalf("harness failed: %v\n%s", err, raw)
	}
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), out); err != nil {
		t.Fatalf("parse harness output: %v\n%s", err, raw)
	}
}

// TestNodeSandboxAbortTerminatesScript pins that aborting a query_code run on
// the Node engine host stops the script, not merely its caller. Escape aborts
// query_code's signal; a run that only settles the caller leaves the script
// executing until its own timeout — up to ten minutes of capability calls
// nobody is waiting for.
func TestNodeSandboxAbortTerminatesScript(t *testing.T) {
	var got struct {
		TicksBeforeAbort int    `json:"ticksBeforeAbort"`
		Outcome          string `json:"outcome"`
		TicksAfterAbort  int    `json:"ticksAfterAbort"`
		TicksLater       int    `json:"ticksLater"`
	}
	runNodeSandboxHarness(t, `
let ticks = 0;
const controller = new AbortController();
const run = runInSandbox(
  'for (;;) { await tick(); await new Promise((r) => setTimeout(r, 10)); }',
  { capabilities: { tick: () => { ticks++; } }, timeoutMs: 60000, signal: controller.signal }
);
const started = Date.now();
while (ticks < 3 && Date.now() - started < 10000) await sleep(10);
const ticksBeforeAbort = ticks;
controller.abort();
const outcome = await Promise.race([
  run.then(() => 'resolved', (e) => (e && e.name) || String(e)),
  sleep(2000).then(() => 'pending'),
]);
// Let anything still in flight at the abort land, then watch for more.
await sleep(200);
const ticksAfterAbort = ticks;
await sleep(500);
console.log(JSON.stringify({ ticksBeforeAbort, outcome, ticksAfterAbort, ticksLater: ticks }));
`, &got)

	if got.TicksBeforeAbort < 3 {
		t.Fatalf("the script never got going (%d capability calls before the abort)", got.TicksBeforeAbort)
	}
	if got.Outcome != "AbortError" {
		t.Errorf("an aborted run must settle the caller with an AbortError, got %q", got.Outcome)
	}
	if got.TicksLater != got.TicksAfterAbort {
		t.Errorf("the script kept running after the abort: %d capability calls became %d over the next 500ms",
			got.TicksAfterAbort, got.TicksLater)
	}
}

// TestNodeSandboxEndsASpinningScript pins that a script busy in its own code —
// a loop that never awaits, so no capability call is in flight and its own
// in-worker timer can never fire — is ended both by an abort (Escape) and by
// its timeout, and that ending it stops the thread rather than abandoning it.
// That includes a run with no deadline (timeoutMs 0, as run_code passes), for
// which the abort is the only thing that can end it: runInSandbox answers its
// caller on the signal by itself, so only the counter shows whether the host
// heard it. The witness is a SharedArrayBuffer the script counts into: the
// count is visible here without the script ever yielding, so a Worker left
// spinning shows as a count that keeps climbing.
func TestNodeSandboxEndsASpinningScript(t *testing.T) {
	type run struct {
		Spinning      bool   `json:"spinning"`
		Outcome       string `json:"outcome"`
		StillCounting bool   `json:"stillCounting"`
	}
	var got map[string]run
	runNodeSandboxHarness(t, `
const shared = new SharedArrayBuffer(4);
const count = new Int32Array(shared);
const capabilities = { counter: () => shared };
const code = 'const c = new Int32Array(await counter());\nfor (;;) Atomics.add(c, 0, 1);';
async function spin(timeoutMs, abort) {
  Atomics.store(count, 0, 0);
  const controller = new AbortController();
  const run = runInSandbox(code, { capabilities, timeoutMs, signal: controller.signal });
  const started = Date.now();
  while (Atomics.load(count, 0) === 0 && Date.now() - started < 10000) await sleep(10);
  const spinning = Atomics.load(count, 0) > 0;
  if (abort) controller.abort();
  const outcome = await Promise.race([
    run.then(() => 'resolved', (e) => (e && e.name === 'AbortError') ? 'AbortError' : String(e && e.message)),
    sleep(timeoutMs + 5000).then(() => 'pending'),
  ]);
  // Let the teardown land, then watch for more counting.
  await sleep(200);
  const after = Atomics.load(count, 0);
  await sleep(500);
  return { spinning, outcome, stillCounting: Atomics.load(count, 0) !== after };
}
console.log(JSON.stringify({
  escape: await spin(60000, true),
  escapeNoDeadline: await spin(0, true),
  timeout: await spin(1000, false),
}));
`, &got)

	if len(got) != 3 {
		t.Fatalf("expected three runs, got %v", got)
	}
	for name, r := range got {
		if !r.Spinning {
			t.Fatalf("%s: the script never started spinning", name)
		}
		if r.StillCounting {
			t.Errorf("%s: the script kept running after it was ended (%q)", name, r.Outcome)
		}
	}
	for _, name := range []string{"escape", "escapeNoDeadline"} {
		if got[name].Outcome != "AbortError" {
			t.Errorf("%s: an abort must settle a spinning run with an AbortError, got %q", name, got[name].Outcome)
		}
	}
	if !strings.Contains(got["timeout"].Outcome, "timed out") {
		t.Errorf("a spinning run must end at its timeout, got %q", got["timeout"].Outcome)
	}
}

// TestNodeSandboxRunsWithNoDeadline pins that `timeoutMs: 0` asks for no
// deadline, on the Node engine host: a run outlives any timer the host or its
// worker would otherwise set. run_code keeps its own clock, which stops while
// the program waits on the user. That the signal still ends such a run is
// pinned by TestNodeSandboxEndsASpinningScript.
func TestNodeSandboxRunsWithNoDeadline(t *testing.T) {
	var got struct {
		Slow string `json:"slow"`
	}
	runNodeSandboxHarness(t, `
const controller = new AbortController();
const slow = await runInSandbox('await new Promise((r) => setTimeout(r, 600)); return "finished";',
  { timeoutMs: 0, signal: controller.signal })
  .then((v) => String(v), (e) => 'error: ' + e.message);
console.log(JSON.stringify({ slow }));
`, &got)

	if got.Slow != "finished" {
		t.Errorf("a run with no deadline must finish however long it takes, got %q", got.Slow)
	}
}

// TestNodeSandboxPointsNodeHabitsAtWhatIsInScope pins, on the Node engine
// host, the same guidance sandbox.html gives: a script
// that imports, requires or redeclares what it already has is told to use it.
func TestNodeSandboxPointsNodeHabitsAtWhatIsInScope(t *testing.T) {
	var got map[string]string
	runNodeSandboxHarness(t, `
const capabilities = { fs: { readFile: async () => 'x' }, grep: async () => [] };
async function errorOf(code) {
  try { await runInSandbox(code, { capabilities, timeoutMs: 10000 }); return 'no error'; }
  catch (e) { return e.message; }
}
console.log(JSON.stringify({
  redeclare: await errorOf('const fs = await import("fs");\nreturn 1;'),
  require: await errorOf('return require("path");'),
  builtin: await errorOf('const m = await import("node:fs");\nreturn 1;'),
}));
`, &got)

	const inScope = "path, projectRoot, fs, grep"
	want := map[string]string{
		"redeclare": "Cannot declare a const variable twice: 'fs'. It is already in scope: use it directly rather than importing or requiring it. In scope: " + inScope + ".",
		"require":   `Couldn't require "path": this sandbox is not Node. Use what is already in scope instead: ` + inScope + ".",
		"builtin":   `Couldn't import "node:fs": this sandbox is not Node. Use what is already in scope instead: ` + inScope + ".",
	}
	for k, w := range want {
		if got[k] != w {
			t.Errorf("%s:\n got %q\nwant %q", k, got[k], w)
		}
	}
}

// TestNodeSandboxCannotReachTheAPI pins that a program on the Node engine host
// cannot use its module loader to reach the server's /api. The loader fetches
// same-origin module URLs over HTTP; the browser sandbox's imports go out from
// an opaque origin with no token, so /api refuses them, and the Node host must
// be no stronger: an /api URL is refused before any request is made, and a
// module that may be imported is fetched without the API token.
func TestNodeSandboxCannotReachTheAPI(t *testing.T) {
	var got struct {
		Relative string     `json:"relative"`
		Absolute string     `json:"absolute"`
		Allowed  string     `json:"allowed"`
		Requests [][]string `json:"requests"`
	}
	runNodeSandboxHarness(t, `
const http = await import('node:http');
const requests = [];
const server = http.createServer((req, res) => {
  requests.push([req.url, req.headers['x-juggler-token'] || '']);
  if (req.url === '/mod.mjs') { res.setHeader('content-type', 'text/javascript'); res.end('export default 42;'); return; }
  res.setHeader('content-type', 'text/javascript');
  res.end('export default "reached";');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = 'http://127.0.0.1:' + server.address().port;
installNodeSandboxDelegate({ origin, token: 'secret-token', projectRoot: '/' }); // a token is ignored
async function outcome(code) {
  try { return String(await runInSandbox(code, { timeoutMs: 10000 })); }
  catch (e) { return 'refused: ' + e.message; }
}
const relative = await outcome('const m = await import("/api/session"); return m.default;');
const absolute = await outcome('const m = await import("' + origin + '/api/session"); return m.default;');
const allowed = await outcome('const m = await import("/mod.mjs"); return m.default;');
server.close();
console.log(JSON.stringify({ relative, absolute, allowed, requests }));
`, &got)

	for name, o := range map[string]string{"relative": got.Relative, "absolute": got.Absolute} {
		if !strings.HasPrefix(o, "refused: ") {
			t.Errorf("an %s /api import must be refused, got %q", name, o)
		}
	}
	if got.Allowed != "42" {
		t.Errorf("an ordinary module import must still load, got %q", got.Allowed)
	}
	for _, r := range got.Requests {
		if strings.HasPrefix(r[0], "/api") {
			t.Errorf("the sandbox reached %s", r[0])
		}
		if r[1] != "" {
			t.Errorf("the sandbox sent the API token with %s", r[0])
		}
	}
}

// TestNodeSandboxConsole pins that a script's console output reaches the
// caller on the Node engine host — on success, on a throw, and when the
// script is killed mid-run — and that it is capped where it is produced.
func TestNodeSandboxConsole(t *testing.T) {
	type run struct {
		Lines  []string `json:"lines"`
		Result any      `json:"result"`
		Error  string   `json:"error"`
	}
	var got map[string]run
	runNodeSandboxHarness(t, `
async function capture(code, timeoutMs = 10000) {
  const lines = [];
  try {
    const result = await runInSandbox(code, { timeoutMs, onConsole: (line) => lines.push(line) });
    return { lines, result };
  } catch (e) {
    return { lines, error: e.message };
  }
}
console.log(JSON.stringify({
  ok: await capture('console.log("hi", { a: 1 }, [2]); console.warn("careful"); console.error(new Error("oops")); return 7;'),
  thrown: await capture('console.log("got this far"); throw new Error("boom");'),
  hung: await capture('console.log("before the hang"); for (;;) {}', 1000),
  capped: await capture('for (let i = 0; i < 500; i++) console.log("line " + i); return "done";'),
}));
`, &got)

	if want := []string{`hi {"a":1} [2]`, "[warn] careful", "[error] Error: oops"}; strings.Join(got["ok"].Lines, "\n") != strings.Join(want, "\n") {
		t.Errorf("console output on success: got %q, want %q", got["ok"].Lines, want)
	}
	if got["ok"].Result != float64(7) {
		t.Errorf("the result must still come back beside the output, got %v", got["ok"].Result)
	}
	if got["thrown"].Error != "boom" || len(got["thrown"].Lines) != 1 || got["thrown"].Lines[0] != "got this far" {
		t.Errorf("output before a throw must survive it: got error %q, lines %q", got["thrown"].Error, got["thrown"].Lines)
	}
	if !strings.Contains(got["hung"].Error, "timed out") || len(got["hung"].Lines) != 1 || got["hung"].Lines[0] != "before the hang" {
		t.Errorf("output before a hang must survive the kill: got error %q, lines %q", got["hung"].Error, got["hung"].Lines)
	}
	capped := got["capped"].Lines
	if len(capped) != 201 || capped[0] != "line 0" || capped[199] != "line 199" ||
		capped[200] != "… console output truncated (limit: 200 lines, 20000 characters)" {
		t.Errorf("output must be capped at 200 lines plus a truncation notice, got %d lines ending %q",
			len(capped), capped[max(0, len(capped)-2):])
	}
}
