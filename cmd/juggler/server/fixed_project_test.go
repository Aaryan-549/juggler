//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/gorilla/mux"

	"juggler/cmd/juggler/core"
)

// fixedProjectServer is a server for a project, with routes and the index
// template loaded, whose project is fixed or not.
func fixedProjectServer(t *testing.T, fixed bool) (*Server, string) {
	t.Helper()
	project := t.TempDir()
	mgr, err := core.NewSessionManagerForPath(project)
	if err != nil {
		t.Fatalf("NewSessionManagerForPath: %v", err)
	}
	t.Cleanup(mgr.Shutdown)
	s := &Server{router: mux.NewRouter(), apiToken: testAPIToken, staticVersion: "test-static-version", fixedProject: fixed}
	s.projectState.Store(&projectState{sessionManager: mgr, projectPath: project})
	if err := s.loadIndexTemplate(); err != nil {
		t.Fatalf("loadIndexTemplate: %v", err)
	}
	s.setupProjectRoutes()
	return s, project
}

// TestFixedProjectRefusesSwitching: a session child's project is the one its
// supervisor spawned it for, and stays so — the supervisor keys the session by
// it and respawns it after a crash. So opening or creating another folder in
// place is refused, before anything is switched or created, and the refusal
// says where to go instead.
func TestFixedProjectRefusesSwitching(t *testing.T) {
	s, project := fixedProjectServer(t, true)
	other := t.TempDir()
	for _, c := range []struct{ path, body string }{
		{"/api/project", `{"path":"` + other + `"}`},
		{"/api/project/new", `{"parent":"` + other + `","name":"fresh"}`},
	} {
		req := httptest.NewRequest(http.MethodPost, c.path, strings.NewReader(c.body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		s.router.ServeHTTP(rec, req)
		if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "sessions page") {
			t.Errorf("POST %s on a fixed project: status %d, body %q; want 409 naming the sessions page", c.path, rec.Code, rec.Body.String())
		}
	}
	if got := s.ProjectPath(); got != project {
		t.Fatalf("project after refused switches = %q, want %q", got, project)
	}
	if entries, _ := os.ReadDir(other); len(entries) != 0 {
		t.Fatalf("a refused create left %v in %s", entries, other)
	}
}

// TestNothingClosesAProject: there is no route that unloads the project.
func TestNothingClosesAProject(t *testing.T) {
	s, project := fixedProjectServer(t, false)
	rec := httptest.NewRecorder()
	s.router.ServeHTTP(rec, httptest.NewRequest(http.MethodDelete, "/api/project", nil))
	if rec.Code < 400 || s.ProjectPath() != project {
		t.Fatalf("DELETE /api/project: status %d, project %q; want it unrouted and %q still loaded", rec.Code, s.ProjectPath(), project)
	}
}

// TestIndexSaysWhetherTheProjectIsFixed: the page learns from the markup it
// is served whether its project can be switched, so the project chip can send
// the user to the sessions page instead of offering a picker that would be
// refused.
func TestIndexSaysWhetherTheProjectIsFixed(t *testing.T) {
	for _, fixed := range []bool{true, false} {
		s, _ := fixedProjectServer(t, fixed)
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.RemoteAddr = localViewerAddr
		rec := httptest.NewRecorder()
		s.serveIndex(rec, req)
		if got := strings.Contains(rec.Body.String(), `data-fixed-project="1"`); got != fixed {
			t.Errorf("fixed=%v: page carries data-fixed-project=%v", fixed, got)
		}
	}
}
