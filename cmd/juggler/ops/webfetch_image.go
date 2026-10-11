//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"encoding/base64"
	"fmt"
	"mime"
	"net/http"
	"slices"
	"strings"
)

// attachableImageMime reports whether mime is one of the image types the read
// op hands the model (imageMimeByExt): the four every provider accepts.
func attachableImageMime(m string) bool {
	for _, v := range imageMimeByExt {
		if v == m {
			return true
		}
	}
	return false
}

// openLabels are Content-Types that say nothing about what a body is, so the
// bytes decide.
var openLabels = []string{"", "application/octet-stream", "binary/octet-stream"}

// mayBeImage reports whether a response so labelled could be an image the
// model can be sent, and so must be read on the image cap.
func mayBeImage(contentType string) bool {
	labelled, _, _ := mime.ParseMediaType(contentType)
	labelled = strings.ToLower(labelled)
	return attachableImageMime(labelled) || slices.Contains(openLabels, labelled)
}

// fetchedImageMime returns the type of a fetched body when it is an image the
// model can be sent, or "". The server's label decides when it names an
// image; one that names nothing useful (none, or octet-stream) is checked
// against the bytes. A body labelled as anything else is not an image,
// whatever it starts with.
func fetchedImageMime(contentType string, body []byte) string {
	labelled, _, _ := mime.ParseMediaType(contentType)
	labelled = strings.ToLower(labelled)
	if attachableImageMime(labelled) {
		return labelled
	}
	if !slices.Contains(openLabels, labelled) {
		return ""
	}
	sniffed, _, _ := mime.ParseMediaType(http.DetectContentType(body))
	if attachableImageMime(sniffed) {
		return sniffed
	}
	return ""
}

// imageFetchResult is the fetch op's answer for an image: its bytes, for the
// engine to store as an attachment as the read op's are, and never as page
// text. One cut off by the size cap is refused rather than sent half-read.
func imageFetchResult(urlStr, prompt, m string, body []byte, truncated bool) (map[string]any, error) {
	if truncated {
		return nil, fmt.Errorf("the image at %s is larger than 5 MB, too large to attach", urlStr)
	}
	return map[string]any{
		"url":         urlStr,
		"prompt":      prompt,
		"isImage":     true,
		"mime":        m,
		"size":        len(body),
		"imageBase64": base64.StdEncoding.EncodeToString(body),
	}, nil
}
