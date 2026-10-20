//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Test-harness message handlers and mock LLM support.
// Compiled into the binary only when -tags production is NOT set.

//go:build !production

package worker

import (
	"encoding/json"
	"sync"

	"juggler/internal/jlog"
)

// pendingMocks holds scripted responses queued under a conversation name for a
// conversation that does not exist yet — one another conversation's tool will
// create. Every worker of a session runs in this process, so the queue can be
// filled through any of them; the worker the named conversation gets takes it
// at init (adoptPendingMocks), before a message can reach it. Name →
// []MockResponse; LoadAndDelete makes taking a queue a single step.
var pendingMocks sync.Map

// handleTestMessage routes test-harness messages. Returns true when the
// message was consumed so the caller can skip the normal switch.
// The production stub always returns false — this code is absent from release binaries.
func (w *ConversationWorker) handleTestMessage(msg workerMessage) bool {
	switch msg.Type {
	case "get-yjs-state":
		w.handleGetYjsState(msg.Payload)
	case "ping":
		w.handlePing(msg.Payload)
	case "set-mock-responses":
		w.handleSetMockResponses(msg.Payload)
	case "release-mock":
		if mock := w.mock(); mock != nil {
			mock.release()
		}
	case "queue-mocks-for-name":
		w.handleQueueMocksForName(msg.Payload)
	default:
		return false
	}
	return true
}

func (w *ConversationWorker) handleGetYjsState(payload json.RawMessage) {
	ackID := w.ackIDOf("get-yjs-state", payload)

	state := w.doc.ToState()
	w.send(AckMessage{Type: msgAck, AckID: ackID, Result: state})
}

// handlePing is a test synchronization barrier. The worker processes
// inbound messages serially, so by the time this handler runs every prior
// yjs-sync / undo / redo has been applied. The UndoManager batches captured
// updates inside a 20 ms timeout window before firing stack-item-added (the
// event that writes undoState to metadata). Force the window closed here so
// undoState is written synchronously, then flush the outbound batcher so
// every resulting Yjs sync precedes the ack.
//
// Closing the capture window in ping is equivalent to letting the 20 ms
// timer fire naturally between operations: subsequent mutations form a new
// undo group exactly as they would have. Tests that want adjacent
// operations to share a group simply don't ping between them.
func (w *ConversationWorker) handlePing(payload json.RawMessage) {
	ackID := w.ackIDOf("ping", payload)

	w.tracker.StopCapturing()
	w.batcher.Flush()
	if ackID != "" {
		w.send(AckMessage{Type: msgAck, AckID: ackID})
		return
	}
	// Callers that don't supply an ackId get the pong frame instead.
	w.send(bareMessage{Type: msgPong})
}

// handleSetMockResponses enables mock mode and sets scripted LLM responses.
// While a script is installed, callLLM() pops and returns these responses instead of calling the real LLM.
func (w *ConversationWorker) handleSetMockResponses(payload json.RawMessage) {
	var msg struct {
		SetMockResponsesMessage
		AckID string `json:"ackId,omitempty"`
	}
	if !w.decodePayload("set-mock-responses", payload, &msg) {
		return
	}

	w.setMockResponses(msg.Responses)
	jlog.Info("[set-mock-responses] conv=%s count=%d payloadLen=%d", w.conversationID, len(msg.Responses), len(payload))

	if msg.AckID != "" {
		w.send(AckMessage{
			Type:   msgAck,
			AckID:  msg.AckID,
			Result: true,
		})
	}
}

// handleQueueMocksForName queues scripted responses for the conversation that
// will be created with the given name (see pendingMocks). The receiving
// worker is only the carrier; its own script is untouched.
func (w *ConversationWorker) handleQueueMocksForName(payload json.RawMessage) {
	var msg struct {
		Name      string         `json:"name"`
		Responses []MockResponse `json:"responses"`
		AckID     string         `json:"ackId,omitempty"`
	}
	if !w.decodePayload("queue-mocks-for-name", payload, &msg) {
		return
	}
	pendingMocks.Store(msg.Name, msg.Responses)
	jlog.Info("[queue-mocks-for-name] via=%s name=%q count=%d", w.conversationID, msg.Name, len(msg.Responses))
	if msg.AckID != "" {
		w.send(AckMessage{Type: msgAck, AckID: msg.AckID, Result: true})
	}
}

// SweepTransactionsForTest synchronously runs the transaction blob GC sweep.
// Production GC piggy-backs on the 2s debounced save (and on shutdown). Tests
// use this to assert the live-set + undoLog contract without waiting for the
// debounce timer.
func (w *ConversationWorker) SweepTransactionsForTest() error {
	return w.sweepTransactions()
}

// HasPendingItems reports whether the thread ("" => root) has any queued
// (not-yet-promoted) messages, so a test can wait for a busy-time send to land
// in the queue before releasing the in-flight turn.
func (w *ConversationWorker) HasPendingItems(threadItemID string) bool {
	return w.hasPendingItems(threadItemID)
}

// adoptPendingMocks installs the responses queued under this conversation's
// name, if any, and spends the queue. Called at init on the run goroutine. A
// script installed directly is never replaced.
func (w *ConversationWorker) adoptPendingMocks() {
	if w.mock() != nil {
		return
	}
	name := w.conversationName()
	if name == "" {
		return
	}
	queued, ok := pendingMocks.LoadAndDelete(name)
	if !ok {
		return
	}
	responses, _ := queued.([]MockResponse)
	w.setMockResponses(responses)
	jlog.Info("[adopt-mocks] conv=%s name=%q count=%d", w.conversationID, name, len(responses))
}
