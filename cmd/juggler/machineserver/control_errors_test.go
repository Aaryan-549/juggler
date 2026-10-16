//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestRefusedOpenCarriesMessage pins the control API's refusal shape, which the
// sessions page shows: {"error": English, "message": {key, params}}, so the
// page can show it translated while a CLI reads the English.
func TestRefusedOpenCarriesMessage(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/server/sessions", strings.NewReader(`{"project":"some/rel"}`))
	rec := httptest.NewRecorder()
	(&Server{}).handleOpenSession(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	var body struct {
		Error   string `json:"error"`
		Message *struct {
			Key    string         `json:"key"`
			Params map[string]any `json:"params"`
		} `json:"message"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("refusal is not JSON: %q", rec.Body.String())
	}
	if want := "project some/rel: give an absolute path, or one starting with ~/"; body.Error != want {
		t.Errorf("error = %q, want %q", body.Error, want)
	}
	if body.Message == nil || body.Message.Key != "project {path}: give an absolute path, or one starting with ~/" {
		t.Fatalf("message = %+v, want the template", body.Message)
	}
	if body.Message.Params["path"] != "some/rel" {
		t.Errorf("params = %v, want path=some/rel", body.Message.Params)
	}
}
