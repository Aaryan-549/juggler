//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// What save-file accepts before it puts a dialog up. Everything here is decided
// from the request alone, so a refusal never shows the user a chooser for
// something that would not be written.
func TestSaveFileRequest(t *testing.T) {
	cases := []struct {
		name, query, body string
		wantName          string
		wantStatus        int
	}{
		{"a file and its name", "name=chat.html", "<html>", "chat.html", http.StatusOK},
		{"no body", "name=chat.html", "", "", http.StatusBadRequest},
		{"no name", "", "<html>", "", http.StatusBadRequest},
		{"a name is a name, not a path", "name=..%2F..%2Fetc%2Fchat.html", "<html>", "chat.html", http.StatusOK},
		{"a Windows path is a path too", "name=C%3A%5Cx%5Cchat.html", "<html>", "chat.html", http.StatusOK},
		{"a name that is only a directory", "name=..", "<html>", "", http.StatusBadRequest},
		{"surrounding space is not part of it", "name=%20chat.html%20", "<html>", "chat.html", http.StatusOK},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, "/win/w1/save-file?"+c.query, strings.NewReader(c.body))
			name, body, status := saveFileRequest(r)
			if status != c.wantStatus {
				t.Fatalf("status = %d, want %d", status, c.wantStatus)
			}
			if status != http.StatusOK {
				return
			}
			if name != c.wantName {
				t.Fatalf("name = %q, want %q", name, c.wantName)
			}
			if string(body) != c.body {
				t.Fatalf("body = %q, want %q", body, c.body)
			}
		})
	}
}

func TestSaveFileRequestRefusesAnOversizeBody(t *testing.T) {
	big := strings.NewReader(strings.Repeat("x", maxSaveFileBytes+1))
	r := httptest.NewRequest(http.MethodPost, "/win/w1/save-file?name=chat.html", big)
	if _, _, status := saveFileRequest(r); status != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", status)
	}
}
