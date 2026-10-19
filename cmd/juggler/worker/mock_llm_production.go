//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Production stub for mock_llm.go: a release build has no scripted provider.

//go:build production

package worker

// mockScript holds nothing in a release build: no worker carries a script.
type mockScript struct{}

// callScriptedLLM never answers in a release build; every call goes to the
// provider.
func (r *run) callScriptedLLM(string, func(StreamChunk)) (scripted bool, response *LLMResponse, err error) {
	return false, nil, nil
}
