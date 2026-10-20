//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

// testCapabilities are the ways a server serving the test harness behaves
// differently from one serving a user — one switch per behaviour, so every
// place that reads one says what it changes rather than asking "is this a
// test?".
//
// Every server starts with all of them off. RegisterTestRoutes turns them on,
// and only once every test feature has matched; a production build's
// RegisterTestRoutes turns on nothing.
type testCapabilities struct {
	// authDisabled takes the per-instance token out of the request path — the
	// /api gate (apiAuthMiddleware) and the viewer WebSocket gate — because the
	// harness drives the server over many synthetic origins and iframes without
	// one. The token path has Go tests of its own.
	authDisabled bool
	// offlineProviders keeps provider bookkeeping off the network: the provider
	// list is mocked, so the providers-ready gate opens at once instead of
	// waiting on a discovery that never comes, and usage stats answer empty
	// rather than calling every credentialed provider upstream.
	offlineProviders bool
	// offlineUpdates keeps the update checker off the network: it never polls,
	// and a manual check answers with the seeded status.
	offlineUpdates bool
	// frameableIndex lets a same-origin frame host the app page, so a browser
	// test can drive the whole shell from a lane.
	frameableIndex bool
	// pageUILocale serves the app page in the language its ?uiLocale= names,
	// without touching the setting every other lane reads (testPageUILocale).
	pageUILocale bool
	// harnessPage serves the app page with the test-mode module
	// (js-tests/utilities/app-test-mode.js), which drives a pool slot and
	// publishes the hooks the harness reads from a hosted shell.
	harnessPage bool
}
