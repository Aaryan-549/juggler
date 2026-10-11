//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"encoding/base64"
	"strings"
	"testing"
)

// pngMagic is the start of every PNG, which content sniffing recognises.
var pngMagic = []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR")

// TestFetchedImageMime pins which fetched bodies are images the model can be
// sent: those the server labels as one of the four types every provider takes,
// and those it labels as nothing useful but whose bytes are one. An SVG is an
// image a model cannot be sent, and HTML stays HTML.
func TestFetchedImageMime(t *testing.T) {
	cases := []struct {
		contentType string
		body        []byte
		want        string
	}{
		{"image/png", []byte("anything"), "image/png"},
		{"image/jpeg; charset=binary", []byte("x"), "image/jpeg"},
		{"IMAGE/WEBP", []byte("x"), "image/webp"},
		{"application/octet-stream", pngMagic, "image/png"},
		{"", pngMagic, "image/png"},
		{"image/svg+xml", []byte("<svg/>"), ""},
		{"text/html; charset=utf-8", []byte("<html></html>"), ""},
		{"text/html", pngMagic, ""},
	}
	for _, c := range cases {
		if got := fetchedImageMime(c.contentType, c.body); got != c.want {
			t.Errorf("fetchedImageMime(%q, %q) = %q, want %q", c.contentType, c.body, got, c.want)
		}
	}
	// What decides the read cap: a body that may be an image is read whole.
	for ct, want := range map[string]bool{"image/png": true, "": true, "application/octet-stream": true, "text/html": false, "image/svg+xml": false} {
		if got := mayBeImage(ct); got != want {
			t.Errorf("mayBeImage(%q) = %v, want %v", ct, got, want)
		}
	}
}

// TestImageFetchResult pins the shape a fetched image comes back in — its
// bytes for the engine to store, never as page text — and that one cut off by
// the size cap is refused rather than sent half-read.
func TestImageFetchResult(t *testing.T) {
	got, err := imageFetchResult("https://example.com/a.png", "what is it", "image/png", pngMagic, false)
	if err != nil {
		t.Fatalf("imageFetchResult: %v", err)
	}
	if got["isImage"] != true || got["mime"] != "image/png" || got["url"] != "https://example.com/a.png" {
		t.Errorf("result = %v", got)
	}
	if got["imageBase64"] != base64.StdEncoding.EncodeToString(pngMagic) || got["size"] != len(pngMagic) {
		t.Errorf("the bytes must come back whole: %v", got)
	}
	if _, has := got["content"]; has {
		t.Errorf("an image has no page text: %v", got)
	}
	if _, err := imageFetchResult("https://example.com/big.png", "", "image/png", pngMagic, true); err == nil ||
		!strings.Contains(err.Error(), "larger than 5 MB") {
		t.Errorf("a truncated image must be refused, got %v", err)
	}
}
