//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"encoding/json"
	"errors"
	"maps"
	"net/http"

	"juggler/cmd/juggler/msg"
	"juggler/internal/jlog"
)

// WriteJSON writes v as a JSON response. If status is non-zero it is written
// via WriteHeader before the body; status == 0 leaves the default 200 / any
// status the caller already set. Encode failures are logged (the response is
// already partially flushed at that point so there is nothing more to do).
func WriteJSON(w http.ResponseWriter, r *http.Request, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	if status != 0 {
		w.WriteHeader(status)
	}
	if err := json.NewEncoder(w).Encode(v); err != nil {
		path := ""
		if r != nil {
			path = r.URL.Path
		}
		jlog.Error("WriteJSON: encode failed for %s: %v", path, err)
	}
}

// errorBody is the one JSON error envelope every /api route shares:
// {"error": text, "message": {...}}. Error is always English — other clients,
// logs and the model read it — and Message, when present, is the same text as
// a msg.Message the UI renders in the viewer's language with serverText().
type errorBody struct {
	Error   string       `json:"error"`
	Message *msg.Message `json:"message,omitempty"`
}

// WriteMessageError sends the error envelope for m: its English as the error,
// and m itself as the message, for the client to show translated. Text the
// server composes is always a msg.Message; an error goes through WriteErr.
// There is no writer that takes bare text, so every failure a route reports
// can reach the UI in the user's language.
//
// The frontend decodes the envelope in a single place (services/http.js), so a
// route that invents its own shape — {"success": false, ...}, {"ok": false,
// ...} — buys nothing: those bodies are only ever produced with a non-2xx
// status, which fetchJson turns into a thrown HttpError before any caller sees
// the body.
//
// Routes that serve something other than JSON on success (static assets, file
// downloads, worker modules, the QR SVG) deliberately keep http.Error: a client
// fetching a script or an image has no JSON decoder waiting for the failure.
func WriteMessageError(w http.ResponseWriter, r *http.Request, status int, m msg.Message) {
	WriteJSON(w, r, status, errorBody{Error: m.English(), Message: &m})
}

// WriteErr sends err as the error envelope: err.Error() as the error, and the
// message ErrorMessage finds in it, if any. An error whose words came from
// elsewhere (OS, git, a provider) is sent as its English alone, since no
// catalogue could hold it.
func WriteErr(w http.ResponseWriter, r *http.Request, status int, err error) {
	WriteJSON(w, r, status, errorBody{Error: err.Error(), Message: ErrorMessage(err)})
}

// ErrorMessage returns the Message of the *msg.Error that err is or wraps, when
// that message is the whole of err's text; otherwise nil. A msg.Error wrapped
// with a prefix of fmt.Errorf's ("loading x: %w") is not the whole text, and
// translating only the part it covers would show the user less than the English
// says — so such an error is sent as English alone.
func ErrorMessage(err error) *msg.Message {
	var me *msg.Error
	if err == nil || !errors.As(err, &me) || me.Error() != err.Error() {
		return nil
	}
	m := me.Message
	return &m
}

// WriteSuccess sends the one JSON success envelope every /api write route
// shares, {"success": true}, with status 200. fields, when non-nil, are merged
// into the same object for a route that reports something alongside it (the
// preset it saved, the URL it started); a "success" key among them is
// overwritten. A route whose answer IS a resource — a board, a workspace, a
// settings document — writes that with WriteJSON instead and carries no flag.
//
// The flag is redundant with the status by construction, for the same reason
// the error envelope's is: a failure never reaches a caller's body. It exists so
// that a client which does look at the body finds one spelling for "done",
// rather than {"success": true} on one route and {"ok": true} on the next.
func WriteSuccess(w http.ResponseWriter, r *http.Request, fields map[string]any) {
	body := make(map[string]any, len(fields)+1)
	maps.Copy(body, fields)
	body["success"] = true
	WriteJSON(w, r, 0, body)
}

// DecodeJSON decodes the request body into a fresh T. A malformed body is
// answered with 400 {"error": "invalid request body"} and reported as ok=false,
// so the handler's whole parse step is two lines:
//
//	req, ok := DecodeJSON[struct{ Name string `json:"name"` }](w, r)
//	if !ok {
//		return
//	}
//
// Handlers whose body is optional (a missing body being as good as an empty
// one) decode it themselves and ignore the error instead.
func DecodeJSON[T any](w http.ResponseWriter, r *http.Request) (T, bool) {
	var v T
	if err := json.NewDecoder(r.Body).Decode(&v); err != nil {
		WriteMessageError(w, r, http.StatusBadRequest, msg.New("invalid request body"))
		// A failed decode can leave v half-populated, so hand back a zero value:
		// a caller that forgets to check ok cannot then act on partial input.
		var zero T
		return zero, false
	}
	return v, true
}
