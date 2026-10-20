//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"encoding/base64"
	"html"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"juggler/cmd/juggler/msg"
)

// Connecting to a server by its address: Session ▸ Connect to Server…, or the
// empty window's "Connect to a server…", which put up a panel in the page that
// posts the typed address here. The window that opens is a connected one (see
// windowSpec), so it is part of the workspace set and reopens at every launch
// until it is closed.
//
// A server by address can be down when the app starts, and a window onto it
// would then be a blank page with nothing in it to act on. So a window whose
// server does not answer opens on a static page instead, saying so, with a way
// to try again and a way out to a local window — which is also how a connected
// server that is gone for good stops being reopened.

var (
	unreachableWindowTitle = msg.New("Server unreachable — Juggler")
	unreachablePageTitle   = msg.New("Can't reach the server")
	unreachableRetry       = msg.New("Try again")
	unreachableTrying      = msg.New("Trying…")
	unreachableOpenLocal   = msg.New("Open a local window instead")

	// connectFromURLWindowRefusal is why a window on a server by URL cannot
	// connect to another (controlConnect).
	connectFromURLWindowRefusal = msg.New("This window shows a server on another computer, so it cannot connect to a different one. Open a new window and connect from there.")
	connectBadAddress           = msg.New("That is not a server address. Enter one like http://devbox:8080.")
)

// unreachableMessage explains the unreachable-server page, naming the server.
func unreachableMessage(serverURL string) msg.Message {
	return msg.New("Juggler could not connect to {url}.\n\n"+
		"Check that the server is running and that this computer can reach it. "+
		"A server answers only on its own machine until LAN access is turned on in its Connectivity settings.",
		"url", serverURL)
}

// normaliseServerURL turns what someone typed as a server's address into the
// origin a window is opened on, or reports that it is not one. A bare host:port
// is taken as http. Only the scheme, host and port are kept: a server is served
// from its root, so a path or query typed with it names nothing extra. Anything
// but http(s), a missing host, a port that is not one, and credentials in the
// address are all refused — the address becomes a window's URL, and the
// control endpoint's secret goes with it.
func normaliseServerURL(raw string) (string, bool) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", false
	}
	if !strings.Contains(s, "://") {
		s = "http://" + s
	}
	u, err := url.Parse(s)
	if err != nil {
		return "", false
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", false
	}
	if u.User != nil || u.Hostname() == "" {
		return "", false
	}
	if p := u.Port(); p != "" {
		if n, err := strconv.Atoi(p); err != nil || n < 1 || n > 65535 {
			return "", false
		}
	}
	return u.Scheme + "://" + strings.ToLower(u.Host), true
}

// controlConnect opens a window onto the server the page names, in reply to its
// Connect to Server panel.
//
// Only a window on a server this app resolved itself — a project or an empty
// window, on a server it spawned or found by its lock — may ask. A window on a
// server by URL is showing a page that server sent, and if it could name
// another host, any server ever connected to could put windows onto anywhere
// it liked, with this app's control secret in their URLs and a place in the
// workspace set.
func (a *appState) controlConnect(w http.ResponseWriter, r *http.Request, e *winEntry) {
	from, ok := a.windowSpecOf(e.id)
	if !ok {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	if from.isURL() {
		writeJSON(w, http.StatusConflict, map[string]any{
			"error":   connectFromURLWindowRefusal.English(),
			"message": connectFromURLWindowRefusal,
		})
		return
	}
	serverURL, ok := normaliseServerURL(r.URL.Query().Get("url"))
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error":   connectBadAddress.English(),
			"message": connectBadAddress,
		})
		return
	}
	// The appearance hand-off, and nothing else the query could say: this is a
	// main window onto another server, not a board of the one asking.
	q := windowOptsFromQuery(r.URL.Query())
	a.connectServer(e, from, serverURL, windowOpts{theme: q.theme, mode: q.mode, zoom: q.zoom})
	w.WriteHeader(http.StatusNoContent)
}

// connectServer opens a connected window onto serverURL, asked for from the
// window from (whose spec is fromSpec).
//
// A window already open on that server is raised instead, and remembered from
// now on if it was a --url one: connecting to it is saying it should come back.
// An empty window asking is replaced by the new one rather than left behind
// beside it, as a dropped folder fills the window it is dropped on.
func (a *appState) connectServer(from *winEntry, fromSpec windowSpec, serverURL string, opts windowOpts) {
	spec := windowSpec{url: serverURL, connected: true}
	var open *winEntry
	a.reg(func(st *regState) {
		for _, w := range st.windows {
			if !isBoardRole(w.role) && w.spec.sameView(spec) {
				w.spec.connected = true
				open = w
				break
			}
		}
	})
	if open != nil {
		a.persistWorkspace()
		focusEntry(open)
		return
	}
	if fromSpec == (windowSpec{}) && !isBoardRole(from.role) {
		opts.replaces = from.id
	}
	logf("connect: opening %s", serverURL)
	a.openWindow(spec, opts)
}

// unreachablePlaceholder reports whether e is the unreachable-server page: a
// window on a server by URL that has no server behind it.
func (a *appState) unreachablePlaceholder(e *winEntry) (windowSpec, bool) {
	spec, ok := a.windowSpecOf(e.id)
	return spec, ok && spec.isURL() && e.serverURL == ""
}

// controlRetryServer is the unreachable-server page's "Try again": a fresh
// attempt at the window it stands in for, which takes its place — the real one
// if the server answers now, another of these pages if it still does not.
//
// 204 whatever happens next: the page posts a form, and any reply with a body
// would replace it with that body.
func (a *appState) controlRetryServer(w http.ResponseWriter, _ *http.Request, e *winEntry) {
	spec, ok := a.unreachablePlaceholder(e)
	if !ok {
		w.WriteHeader(http.StatusConflict)
		return
	}
	a.openWindow(spec, windowOpts{theme: e.currentTheme, replaces: e.id})
	w.WriteHeader(http.StatusNoContent)
}

// controlOpenLocal is the unreachable-server page's way out: an empty local
// window in its place. Taking the page's place is what drops the server from
// the workspace set, which a plain close of the last window would not (an
// empty set is never written, so the app would reopen it next launch).
func (a *appState) controlOpenLocal(w http.ResponseWriter, _ *http.Request, e *winEntry) {
	if _, ok := a.unreachablePlaceholder(e); !ok {
		w.WriteHeader(http.StatusConflict)
		return
	}
	a.openWindow(windowSpec{}, windowOpts{theme: e.currentTheme, replaces: e.id})
	w.WriteHeader(http.StatusNoContent)
}

// buildUnreachableServerWindow opens the unreachable-server page in place of a
// window onto spec's server. It is registered under spec, so a connected server
// keeps its place in the workspace set while the page is up.
func (a *appState) buildUnreachableServerWindow(spec windowSpec, inheritedTheme string) *winEntry {
	logf("server unreachable: %s", spec.url)
	text := unreachableServerText{
		title:     a.tr(unreachablePageTitle),
		message:   a.tr(unreachableMessage(spec.url)),
		retry:     a.tr(unreachableRetry),
		trying:    a.tr(unreachableTrying),
		openLocal: a.tr(unreachableOpenLocal),
	}
	return a.buildPlaceholderWindow(spec, a.tr(unreachableWindowTitle), func(id string) string {
		page := text
		page.controlBase = a.controlBase(id)
		return unreachableServerPage(page)
	}, inheritedTheme)
}

// unreachableServerText is what the unreachable-server page says, in the UI
// language, and the control endpoint of the window showing it.
type unreachableServerText struct {
	title, message, retry, trying, openLocal string
	controlBase                              string
}

// unreachableServerPage renders the page as a data URL, like the locked-project
// page and for the same reason: there is no server to serve it from. Its two
// buttons are plain form posts to this window's control endpoint, which needs
// no script and no CORS — the script only says the retry is under way, since
// the window that answers it replaces this one.
func unreachableServerPage(p unreachableServerText) string {
	t := html.EscapeString(p.title)
	action := func(name string) string { return html.EscapeString(p.controlBase + "/" + name) }
	doc := `<!doctype html><meta charset="utf-8"><title>` + t + `</title>` +
		`<style>body{margin:0;padding:48px;background:#0d1117;color:#e6edf3;font:16px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.5}` +
		`main{max-width:720px;margin:auto}h1{margin-top:0}pre{white-space:pre-wrap;font:inherit}` +
		`.actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:24px}form{margin:0}` +
		`button{font:inherit;padding:8px 16px;border-radius:6px;border:1px solid #30363d;background:#21262d;color:#e6edf3;cursor:pointer}` +
		`button.primary{background:#238636;border-color:#2ea043}button:disabled{opacity:.6;cursor:default}</style>` +
		`<main><h1>` + t + `</h1><pre>` + html.EscapeString(p.message) + `</pre><div class="actions">` +
		`<form method="post" action="` + action("retry-server") + `" onsubmit="` +
		html.EscapeString("var b=this.querySelector('button');b.disabled=true;b.textContent="+jsString(p.trying)) + `">` +
		`<button type="submit" class="primary">` + html.EscapeString(p.retry) + `</button></form>` +
		`<form method="post" action="` + action("open-local") + `">` +
		`<button type="submit">` + html.EscapeString(p.openLocal) + `</button></form>` +
		`</div></main>`
	// Base64 for the reasons lockedProjectPage gives.
	return "data:text/html;charset=utf-8;base64," + base64.StdEncoding.EncodeToString([]byte(doc))
}
