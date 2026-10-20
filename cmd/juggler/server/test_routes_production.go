//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build production

package server

// RegisterTestRoutes in a production build: the test routes, pages and
// capabilities are not compiled in (test_routes.go), so a release binary
// started with --test stops here rather than serving as if it were a test
// server.
func (s *Server) RegisterTestRoutes(_ any) {
	panic("RegisterTestRoutes: this is a production-tagged build, which has no test routes (--test is unsupported)")
}
