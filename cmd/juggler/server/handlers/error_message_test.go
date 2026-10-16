//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"juggler/cmd/juggler/core"
)

// errorEnvelope is the error body every /api route writes: the English text,
// and the message the client translates when there is one.
type errorEnvelope struct {
	Error   string `json:"error"`
	Message *struct {
		Key     string         `json:"key"`
		Params  map[string]any `json:"params"`
		Context string         `json:"context"`
	} `json:"message"`
}

// decodeErrorEnvelope decodes rec's body as the error envelope.
func decodeErrorEnvelope(t *testing.T, rec *httptest.ResponseRecorder) errorEnvelope {
	t.Helper()
	var env errorEnvelope
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("decode error body %q: %v", rec.Body.String(), err)
	}
	return env
}

// TestDecodeJSONErrorCarriesMessage: a malformed body is answered with the
// English the error field has always held, and the message to translate it by.
func TestDecodeJSONErrorCarriesMessage(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/x", strings.NewReader("{not json"))
	if _, ok := DecodeJSON[struct{}](rec, req); ok {
		t.Fatal("DecodeJSON accepted a malformed body")
	}
	env := decodeErrorEnvelope(t, rec)
	if env.Error != "invalid request body" {
		t.Errorf("error = %q, want the English unchanged", env.Error)
	}
	if env.Message == nil || env.Message.Key != "invalid request body" {
		t.Fatalf("message = %+v, want key %q", env.Message, "invalid request body")
	}
}

// TestOperationRefusalCarriesMessage: a refusal made as a msg.Error far from
// the handler — the workspace lookup's — reaches the op response as its
// template and values beside the English the model reads, through the whole
// HTTP path.
func TestOperationRefusalCarriesMessage(t *testing.T) {
	project, ws := projectAndWorkspace(t)
	api := opsAPIForTest(project, map[string]core.Workspace{
		"ws_closed": {ID: "ws_closed", Kind: core.WorkspaceKindLocal, Root: ws, Label: "feat/done", State: core.WorkspaceStateClosed},
	})
	body := `{"toolId":"read-file","operation":"loadFile","params":{"path":"in-workspace.txt"},"workspaceId":"ws_closed"}`
	rec := httptest.NewRecorder()
	api.HandleOperationCall(rec, httptest.NewRequest(http.MethodPost, "/api/ops/call", strings.NewReader(body)))

	var resp struct {
		Success bool   `json:"success"`
		Error   string `json:"error"`
		Message *struct {
			Key    string         `json:"key"`
			Params map[string]any `json:"params"`
		} `json:"message"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode %q: %v", rec.Body.String(), err)
	}
	if resp.Success || resp.Error != "workspace feat/done was closed" {
		t.Fatalf("response = %s, want a refusal reading %q", rec.Body.String(), "workspace feat/done was closed")
	}
	if resp.Message == nil || resp.Message.Key != "workspace {name} was closed" {
		t.Fatalf("message = %+v, want key %q", resp.Message, "workspace {name} was closed")
	}
	if got := resp.Message.Params["name"]; got != "feat/done" {
		t.Errorf("params.name = %v, want %q", got, "feat/done")
	}
}

// TestCheckProjectCarriesMessage: /project/check answers 200 with its refusal
// in "error", so the message to translate it by rides beside it as
// "errorMessage".
func TestCheckProjectCarriesMessage(t *testing.T) {
	api, _ := newProjectTestAPI()
	missing := filepath.Join(t.TempDir(), "nope")
	rec := httptest.NewRecorder()
	api.HandleCheckProject(rec, httptest.NewRequest(http.MethodGet, "/api/project/check?path="+missing, nil))

	var resp struct {
		Valid        bool   `json:"valid"`
		Error        string `json:"error"`
		ErrorMessage *struct {
			Key string `json:"key"`
		} `json:"errorMessage"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode %q: %v", rec.Body.String(), err)
	}
	if resp.Valid || resp.Error != "path not found" {
		t.Fatalf("response = %s, want an invalid path reading %q", rec.Body.String(), "path not found")
	}
	if resp.ErrorMessage == nil || resp.ErrorMessage.Key != "path not found" {
		t.Fatalf("errorMessage = %+v, want key %q", resp.ErrorMessage, "path not found")
	}
}

// TestNewProjectErrorCarriesMessage: an interpolated refusal travels as its
// template and the value, not as the sentence with the value baked in.
func TestNewProjectErrorCarriesMessage(t *testing.T) {
	api, _ := newProjectTestAPI()
	parent := filepath.Join(t.TempDir(), "typo")

	rec := serveNewProject(api, parent, "myapp")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body %q)", rec.Code, rec.Body.String())
	}
	env := decodeErrorEnvelope(t, rec)
	if env.Error != "parent folder not found: "+parent {
		t.Errorf("error = %q, want the English unchanged", env.Error)
	}
	if env.Message == nil || env.Message.Key != "parent folder not found: {path}" {
		t.Fatalf("message = %+v, want key %q", env.Message, "parent folder not found: {path}")
	}
	if got := env.Message.Params["path"]; got != parent {
		t.Errorf("params.path = %v, want %q", got, parent)
	}
}
