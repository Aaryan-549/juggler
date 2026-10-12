//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/internal/userpaths/userpathstest"
)

// getRecentModels drives the GET handler and returns the decoded list.
func getRecentModels(t *testing.T, api *ModelPreferencesAPI) []core.ModelRef {
	t.Helper()
	rec := httptest.NewRecorder()
	api.HandleRecentModels(rec, httptest.NewRequest(http.MethodGet, "/api/recent-models", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Models []core.ModelRef `json:"models"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode GET response: %v", err)
	}
	return body.Models
}

// postRecentModel drives the POST handler for one pick.
func postRecentModel(t *testing.T, api *ModelPreferencesAPI, providerName, model string) {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/recent-models",
		strings.NewReader(`{"provider":"`+providerName+`","model":"`+model+`"}`))
	api.HandleRecentModels(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

// TestRecentModelsHandlerRoundTrip locks the HTTP contract: GET is empty
// initially, POST records most-recent-first, and a repeat pick dedups to the
// front. The API has no concept of provider availability, so recording is
// inherently decoupled from whether the model currently works.
func TestRecentModelsHandlerRoundTrip(t *testing.T) {
	userpathstest.Isolate(t)
	store, err := core.NewRecentModelsStore()
	if err != nil {
		t.Fatalf("NewRecentModelsStore: %v", err)
	}
	api := NewModelPreferencesAPI(nil, nil, store, nil)

	if got := getRecentModels(t, api); len(got) != 0 {
		t.Fatalf("expected empty list initially, got %v", got)
	}

	postRecentModel(t, api, "anthropic", "claude")
	postRecentModel(t, api, "openaicodex", "gpt-5")

	got := getRecentModels(t, api)
	want := []core.ModelRef{
		{Provider: "openaicodex", Model: "gpt-5"},
		{Provider: "anthropic", Model: "claude"},
	}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("after two POSTs got %v, want %v", got, want)
	}

	// Re-pick the older model — it should jump to the front, not duplicate.
	postRecentModel(t, api, "anthropic", "claude")
	got = getRecentModels(t, api)
	want = []core.ModelRef{
		{Provider: "anthropic", Model: "claude"},
		{Provider: "openaicodex", Model: "gpt-5"},
	}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("after dedup POST got %v, want %v", got, want)
	}
}

// TestRecentModelsHandlerThinkingTriple locks the optional `thinking` field in
// the HTTP contract: POST accepts it, GET returns it, and dedupe is by the
// full provider+model+thinking triple — the same model at two levels is two
// distinct entries.
func TestRecentModelsHandlerThinkingTriple(t *testing.T) {
	userpathstest.Isolate(t)
	store, err := core.NewRecentModelsStore()
	if err != nil {
		t.Fatalf("NewRecentModelsStore: %v", err)
	}
	api := NewModelPreferencesAPI(nil, nil, store, nil)

	post := func(body string) {
		t.Helper()
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/recent-models", strings.NewReader(body))
		api.HandleRecentModels(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("POST status = %d, body = %s", rec.Code, rec.Body.String())
		}
	}

	post(`{"provider":"anthropic","model":"claude"}`)
	post(`{"provider":"anthropic","model":"claude","thinking":"high"}`)

	got := getRecentModels(t, api)
	want := []core.ModelRef{
		{Provider: "anthropic", Model: "claude", Thinking: "high"},
		{Provider: "anthropic", Model: "claude"},
	}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("after level-distinct POSTs got %v, want %v", got, want)
	}

	// Re-picking the exact triple moves it to the front without duplicating.
	post(`{"provider":"anthropic","model":"claude"}`)
	got = getRecentModels(t, api)
	want = []core.ModelRef{
		{Provider: "anthropic", Model: "claude"},
		{Provider: "anthropic", Model: "claude", Thinking: "high"},
	}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("after triple-dedup POST got %v, want %v", got, want)
	}
}

// TestRecentModelsHandlerServiceTierRoundTrip locks the optional `serviceTier`
// field in the HTTP contract. The recorded entry is what a Recent row re-applies
// verbatim, so a tier the POST decoder ignored would leave the user re-picking
// their model at standard serving with nothing to show it changed.
func TestRecentModelsHandlerServiceTierRoundTrip(t *testing.T) {
	userpathstest.Isolate(t)
	store, err := core.NewRecentModelsStore()
	if err != nil {
		t.Fatalf("NewRecentModelsStore: %v", err)
	}
	api := NewModelPreferencesAPI(nil, nil, store, nil)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/recent-models",
		strings.NewReader(`{"provider":"openaicodex","model":"gpt-5","thinking":"high","serviceTier":"priority"}`))
	api.HandleRecentModels(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST status = %d, body = %s", rec.Code, rec.Body.String())
	}

	got := getRecentModels(t, api)
	want := core.ModelRef{Provider: "openaicodex", Model: "gpt-5", Thinking: "high", ServiceTier: "priority"}
	if len(got) != 1 || got[0] != want {
		t.Fatalf("recent models = %v, want [%v]", got, want)
	}
}

// TestRecentModelsHandlerNilStore tolerates an API with no store wired,
// returning an empty list rather than erroring.
func TestRecentModelsHandlerNilStore(t *testing.T) {
	api := NewModelPreferencesAPI(nil, nil, nil, nil)
	if got := getRecentModels(t, api); len(got) != 0 {
		t.Fatalf("expected empty list from nil store, got %v", got)
	}
}
