//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package worker

import (
	"encoding/json"
	"testing"
)

func queueMocksForName(t *testing.T, via *ConversationWorker, name string, count int) {
	t.Helper()
	responses := make([]MockResponse, count)
	for i := range responses {
		responses[i] = MockResponse{StopReason: "end_turn"}
	}
	payload, err := json.Marshal(map[string]any{"name": name, "responses": responses})
	if err != nil {
		t.Fatal(err)
	}
	if !via.handleTestMessage(workerMessage{Type: "queue-mocks-for-name", Payload: payload}) {
		t.Fatal("queue-mocks-for-name was not handled as a test message")
	}
}

// TestMocksQueuedByNameGoToTheConversationCreatedWithThatName pins the path a
// conversation made by another conversation's tool takes: its scripted turns
// are queued, through any worker, under the name it will be given, and the
// worker that conversation gets adopts them at init, before a message can
// reach it. A queue is spent once, and other names are left alone.
func TestMocksQueuedByNameGoToTheConversationCreatedWithThatName(t *testing.T) {
	var calls []autoNameCall
	parent := namedWorker(t, "conv_mbn_parent", "partial refund bug", &calls)
	queueMocksForName(t, parent, "mbn audit idempotency keys", 3)

	other := namedWorker(t, "conv_mbn_other", "mbn something else", &calls)
	other.adoptPendingMocks()
	if other.mock() != nil {
		t.Fatal("a conversation with a different name adopted the queue")
	}

	child := namedWorker(t, "conv_mbn_child", "mbn audit idempotency keys", &calls)
	child.adoptPendingMocks()
	if child.mock() == nil || child.mock().remaining() != 3 {
		t.Fatalf("child adopted %v, want the 3 queued responses", child.mock())
	}

	again := namedWorker(t, "conv_mbn_again", "mbn audit idempotency keys", &calls)
	again.adoptPendingMocks()
	if again.mock() != nil {
		t.Fatal("a queue was adopted twice; it belongs to the first conversation with the name")
	}
}

// TestAdoptPendingMocksKeepsAnInstalledScript pins that adoption never replaces
// a script a test installed directly.
func TestAdoptPendingMocksKeepsAnInstalledScript(t *testing.T) {
	var calls []autoNameCall
	w := namedWorker(t, "conv_mbn_kept", "mbn kept", &calls)
	w.setMockResponses([]MockResponse{{StopReason: "end_turn"}})
	queueMocksForName(t, w, "mbn kept", 4)
	w.adoptPendingMocks()
	if w.mock().remaining() != 1 {
		t.Fatalf("remaining = %d, want the directly installed 1", w.mock().remaining())
	}
}
