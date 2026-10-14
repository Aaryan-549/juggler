//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"text/tabwriter"
	"time"

	"juggler/internal/userpaths"
)

// The command line's view of the machine server: `juggler server
// status|sessions|stop` and `juggler open <project>`. Each finds the running
// server the way any client on this machine does — server.json for its address
// and control-API token — and drives the control API. None starts a server.

// CLIEnv is where a CLI command writes, and how it opens a URL in a browser.
type CLIEnv struct {
	Stdout, Stderr io.Writer
	OpenBrowser    func(url string) error
}

// errNoServer is every command's answer when no machine server is running.
var errNoServer = errors.New("no Juggler server is running on this machine; start one with `juggler serve`")

// cliTimeout bounds one control-API call. An open waits out a child's spawn,
// which the server bounds itself (childStartTimeout).
const cliTimeout = childStartTimeout + 10*time.Second

const serverUsage = `Usage: juggler server <command>

Commands:
  status                 Show the running server: address, version, sessions.
  sessions [--json]      List its sessions.
  stop [<id|project>]    Stop one session, or with no argument the whole server.
`

// RunServerCommand runs `juggler server <verb>` and returns its exit code.
func RunServerCommand(args []string, env CLIEnv) int {
	if len(args) == 0 {
		fmt.Fprint(env.Stderr, serverUsage)
		return 2
	}
	verb, rest := args[0], args[1:]
	switch verb {
	case "status":
		return cliStatus(env)
	case "sessions":
		fs := flag.NewFlagSet("server sessions", flag.ContinueOnError)
		fs.SetOutput(env.Stderr)
		asJSON := fs.Bool("json", false, "Print the sessions as JSON")
		if err := fs.Parse(rest); err != nil {
			return 2
		}
		return cliSessions(env, *asJSON)
	case "stop":
		if len(rest) > 1 {
			fmt.Fprint(env.Stderr, serverUsage)
			return 2
		}
		if len(rest) == 0 {
			return cliShutdown(env)
		}
		return cliStopSession(env, rest[0])
	default:
		fmt.Fprintf(env.Stderr, "juggler server: unknown command %q\n\n%s", verb, serverUsage)
		return 2
	}
}

// RunOpenCommand runs `juggler open [--browser] <project>`: it opens (or finds)
// the session for the folder and prints its URL. The folder is taken as typed:
// relative to where the command runs, or under ~.
func RunOpenCommand(args []string, env CLIEnv) int {
	fs := flag.NewFlagSet("open", flag.ContinueOnError)
	fs.SetOutput(env.Stderr)
	browser := fs.Bool("browser", false, "Also open the session in the default browser")
	fs.Usage = func() {
		fmt.Fprint(env.Stderr, "Usage: juggler open [--browser] <project folder>\n\n"+
			"Opens a session for the folder on this machine's Juggler server and prints its URL.\n")
	}
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() != 1 {
		fs.Usage()
		return 2
	}
	project, err := cliPath(fs.Arg(0))
	if err != nil {
		fmt.Fprintf(env.Stderr, "juggler open: %v\n", err)
		return 1
	}
	c, err := discover()
	if err != nil {
		return cliFail(env, "open", err)
	}
	var sess Session
	if err := c.do(http.MethodPost, "/sessions", map[string]string{"project": project}, &sess); err != nil {
		return cliFail(env, "open", err)
	}
	url := c.sessionURL(sess.ID)
	fmt.Fprintln(env.Stdout, url)
	if *browser && env.OpenBrowser != nil {
		if err := env.OpenBrowser(url); err != nil {
			fmt.Fprintf(env.Stderr, "juggler open: could not open a browser: %v\n", err)
			return 1
		}
	}
	return 0
}

func cliStatus(env CLIEnv) int {
	c, err := discover()
	if err != nil {
		return cliFail(env, "server status", err)
	}
	var st statusResponse
	if err := c.do(http.MethodGet, "/status", nil, &st); err != nil {
		return cliFail(env, "server status", err)
	}
	noun := "sessions"
	if st.Sessions == 1 {
		noun = "session"
	}
	fmt.Fprintf(env.Stdout, "Juggler server %s at http://%s/\npid %d, up %s, %d %s\n",
		st.Version, st.Addr, st.PID, time.Since(st.StartedAt).Round(time.Second), st.Sessions, noun)
	return 0
}

func cliSessions(env CLIEnv, asJSON bool) int {
	c, err := discover()
	if err != nil {
		return cliFail(env, "server sessions", err)
	}
	var list []Session
	if err := c.do(http.MethodGet, "/sessions", nil, &list); err != nil {
		return cliFail(env, "server sessions", err)
	}
	if asJSON {
		enc := json.NewEncoder(env.Stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(list); err != nil {
			return cliFail(env, "server sessions", err)
		}
		return 0
	}
	if len(list) == 0 {
		fmt.Fprintln(env.Stdout, "No sessions are running.")
		return 0
	}
	tw := tabwriter.NewWriter(env.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "ID\tSTATE\tLAST ACTIVE\tPROJECT")
	for _, s := range list {
		last := "-"
		if s.LastActive != nil {
			last = time.Since(*s.LastActive).Round(time.Second).String() + " ago"
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", s.ID, cliState(s), last, s.Project)
		if s.Error != "" {
			fmt.Fprintf(tw, "\t\t\t  %s\n", s.Error)
		}
	}
	if err := tw.Flush(); err != nil {
		return cliFail(env, "server sessions", err)
	}
	return 0
}

// cliState is what a session is doing, as the sessions page says it: a
// running session is busy or idle.
func cliState(s Session) string {
	if s.State != SessionRunning {
		return string(s.State)
	}
	if s.Busy {
		return "busy"
	}
	return "idle"
}

func cliShutdown(env CLIEnv) int {
	c, err := discover()
	if err != nil {
		return cliFail(env, "server stop", err)
	}
	if err := c.do(http.MethodPost, "/shutdown", nil, nil); err != nil {
		return cliFail(env, "server stop", err)
	}
	fmt.Fprintf(env.Stdout, "Stopping the Juggler server at http://%s/ and its sessions.\n", c.addr)
	return 0
}

// cliStopSession stops the session named by its ID, or by its project folder
// as typed.
func cliStopSession(env CLIEnv, which string) int {
	c, err := discover()
	if err != nil {
		return cliFail(env, "server stop", err)
	}
	var list []Session
	if err := c.do(http.MethodGet, "/sessions", nil, &list); err != nil {
		return cliFail(env, "server stop", err)
	}
	project, _ := cliPath(which)
	var target *Session
	for i := range list {
		if list[i].ID == which || (project != "" && list[i].Project == project) {
			target = &list[i]
			break
		}
	}
	if target == nil {
		fmt.Fprintf(env.Stderr, "juggler server stop: no session is running for %q (see `juggler server sessions`)\n", which)
		return 1
	}
	if err := c.do(http.MethodDelete, "/sessions/"+target.ID, nil, nil); err != nil {
		return cliFail(env, "server stop", err)
	}
	fmt.Fprintf(env.Stdout, "Stopped session %s (%s).\n", target.ID, target.Project)
	return 0
}

// cliPath makes a folder given on the command line absolute: under ~, or
// relative to where the command runs. The server takes only absolute paths
// (resolveProject), since its own working directory means nothing to a caller.
func cliPath(p string) (string, error) {
	if p == "" {
		return "", errors.New("no folder given")
	}
	return filepath.Abs(userpaths.ExpandHome(p))
}

func cliFail(env CLIEnv, cmd string, err error) int {
	fmt.Fprintf(env.Stderr, "juggler %s: %v\n", cmd, err)
	return 1
}

// controlClient calls the running machine server's control API.
type controlClient struct {
	addr  string
	token string
	http  *http.Client
}

// discover finds the running machine server through server.json.
func discover() (*controlClient, error) {
	info := NewMachineLock(userpaths.ConfigDir()).readInfo()
	if info == nil || info.Addr == "" {
		return nil, errNoServer
	}
	return &controlClient{addr: info.Addr, token: info.Token, http: &http.Client{Timeout: cliTimeout}}, nil
}

// sessionURL is where a session is served on this server.
func (c *controlClient) sessionURL(id string) string {
	return "http://" + c.addr + "/s/" + id + "/"
}

// do sends one control-API request and decodes a JSON answer into out (when
// non-nil). A server that does not answer is reported as no server at all;
// one that refuses says why.
func (c *controlClient) do(method, path string, body, out any) error {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, "http://"+c.addr+"/api/server"+path, rd) //nolint:noctx // bounded by the client's timeout
	if err != nil {
		return err
	}
	req.Header.Set(TokenHeader, c.token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("%w (server.json names %s, which is not answering)", errNoServer, c.addr)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 300 {
		var sess Session
		if json.Unmarshal(data, &sess) == nil && sess.Error != "" {
			return errors.New(sess.Error)
		}
		return errors.New(strings.TrimSpace(string(data)))
	}
	if out != nil && len(data) > 0 {
		return json.Unmarshal(data, out)
	}
	return nil
}
