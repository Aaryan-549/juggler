//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

// A running worker's lifetime: the context it is started under, and what a stop
// owes the turns still streaming when it comes.

import (
	"context"
	"encoding/json"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"juggler/cmd/juggler/providers/provider"
)

// savedDocs records every document state a worker writes, so a test can read
// the last one the way the next launch would, and whether a turn was still
// running when it was written.
type savedDocs struct {
	last          atomic.Pointer[[]byte]
	lastWhileLive atomic.Bool
	// live reports whether a turn is still running. Set once the worker exists.
	live atomic.Pointer[func() bool]
}

func (s *savedDocs) save(_ string, data []byte) error {
	saved := append([]byte(nil), data...)
	s.last.Store(&saved)
	live := s.live.Load()
	s.lastWhileLive.Store(live != nil && (*live)())
	return nil
}

// unfinishedTurn reports whether any turn w has registered has yet to return.
func unfinishedTurn(w *ConversationWorker) bool {
	for _, e := range w.sched.runs() {
		select {
		case <-e.t.finished:
		default:
			return true
		}
	}
	return false
}

// items decodes the last saved state.
func (s *savedDocs) items(t *testing.T) []ConversationItem {
	t.Helper()
	p := s.last.Load()
	if p == nil || len(*p) == 0 {
		t.Fatal("the worker never saved its document")
	}
	doc := NewConversationDocument("verify", "user:test")
	defer doc.Destroy()
	if err := doc.LoadFromState(*p); err != nil {
		t.Fatalf("loading the saved state: %v", err)
	}
	return doc.GetItems()
}

// startCallingWorker returns an initialized worker running under ctx, with a
// model configured, the engine answered, every save recorded in saved, and llm
// as its provider. The worker is stopped when the test ends, unless the test
// stopped it itself.
func startCallingWorker(t *testing.T, ctx context.Context, llm LLMCallFunc, saved *savedDocs) *ConversationWorker {
	t.Helper()
	w := NewConversationWorker("conv-lifetime", "user:test")
	t.Cleanup(func() { w.doc.Destroy() })
	initPayload, err := json.Marshal(InitMessage{
		Type:         "init",
		Conversation: SerializedConversation{ID: "conv-lifetime"},
		Config:       WorkerConfig{ProjectPath: t.TempDir()},
	})
	if err != nil {
		t.Fatalf("marshalling init: %v", err)
	}
	if saved != nil {
		w.SetSaveBinary(saved.save)
	}
	w.SetLLMCaller(llm)
	w.currentRun().handleInit(initPayload)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	answerEngineRequests(w, nil, func() *SubthreadSpec { return nil })
	w.SetCallback("client", func([]byte) {})
	w.Start(ctx)
	t.Cleanup(func() {
		select {
		case <-w.stopped:
		default:
			w.Stop()
		}
	})
	return w
}

// workerContextKey marks the context a worker is started under.
type workerContextKey struct{}

// TestLLMCallRunsUnderTheWorkersContext pins the provider call's context to the
// one the worker was started with, so whatever that context carries — a server
// shutdown's cancellation above all — reaches the call. A context of its own
// would leave a stopping server waiting on a stream nothing had told to end.
func TestLLMCallRunsUnderTheWorkersContext(t *testing.T) {
	seen := make(chan any, 1)
	llm := func(ctx context.Context, _ json.RawMessage, _ func(StreamChunk)) (*LLMResponse, error) {
		select {
		case seen <- ctx.Value(workerContextKey{}):
		default:
		}
		return &LLMResponse{
			Blocks:     []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "an answer"}},
			StopReason: "end_turn",
		}, nil
	}
	ctx := context.WithValue(context.Background(), workerContextKey{}, "the worker's")
	w := startCallingWorker(t, ctx, llm, nil)
	sendUserMessage(t, w, "hello")

	select {
	case got := <-seen:
		if got != "the worker's" {
			t.Fatalf("the provider call ran under a context the worker was not started with (marker = %v)", got)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the provider was never called")
	}
}

// TestStopSavesTheTextALiveTurnHasStreamed pins what a stop owes a turn still
// streaming: the final save comes after the turn has unwound, and so holds every
// word the provider had sent — including the tail the stream-write throttle was
// still holding back from the document. Saving first loses that tail on every
// quit mid-answer, since the save is the last one the conversation gets.
//
// A turn unwound by a stop also ends quietly. Its call failed only because the
// worker stopped, which is not an error the conversation made, and the saved
// transcript must not carry one into the next launch.
//
// Both ways a worker is stopped are covered: Stop, and the cancellation of the
// context it was started under, which is what a server shutdown does first.
func TestStopSavesTheTextALiveTurnHasStreamed(t *testing.T) {
	const head = "The opening words of an answer, written as they arrive"
	const tail = " and a tail"

	for _, tc := range []struct {
		name string
		stop func(w *ConversationWorker, cancel context.CancelFunc)
	}{
		{"Stop", func(w *ConversationWorker, _ context.CancelFunc) { w.Stop() }},
		{"its context cancelled", func(w *ConversationWorker, cancel context.CancelFunc) {
			cancel()
			select {
			case <-w.stopped:
			case <-time.After(10 * time.Second):
				panic("the worker never stopped after its context was cancelled")
			}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			saved := &savedDocs{}
			streamed := make(chan struct{})
			var w *ConversationWorker
			llm := func(ctx context.Context, _ json.RawMessage, sink func(StreamChunk)) (*LLMResponse, error) {
				sink(StreamChunk{Type: provider.ContentBlockTypeText, Content: head})
				// The tail must arrive as a chunk of its own, after the head is in
				// the document, or the turn coalesces the two into one write.
				deadline := time.Now().Add(5 * time.Second)
				for !holdsAssistantText(w.doc.GetItems(), head) && time.Now().Before(deadline) {
					time.Sleep(2 * time.Millisecond)
				}
				sink(StreamChunk{Type: provider.ContentBlockTypeText, Content: tail})
				close(streamed)
				<-ctx.Done()
				return nil, ctx.Err()
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			w = startCallingWorker(t, ctx, llm, saved)
			live := func() bool { return unfinishedTurn(w) }
			saved.live.Store(&live)
			sendUserMessage(t, w, "tell me something")

			select {
			case <-streamed:
			case <-time.After(10 * time.Second):
				t.Fatal("the provider never streamed")
			}
			tc.stop(w, cancel)

			if saved.lastWhileLive.Load() {
				t.Error("the final save was written while a turn was still running; whatever it wrote afterwards is lost")
			}
			items := saved.items(t)
			if !holdsAssistantText(items, head+tail) {
				t.Errorf("the saved transcript does not hold the whole streamed answer %q:\n%s", head+tail, describeItems(items))
			}
			for _, it := range items {
				if it.Type == ItemTypeError {
					t.Errorf("the saved transcript carries an error the stop caused: %q", it.Content)
				}
			}
		})
	}
}

// holdsAssistantText reports whether items hold an assistant message reading
// exactly text.
func holdsAssistantText(items []ConversationItem, text string) bool {
	for _, it := range items {
		if it.Type == ItemTypeAssistant && it.Content == text {
			return true
		}
	}
	return false
}

// describeItems renders items one per line, for a failure message.
func describeItems(items []ConversationItem) string {
	var b strings.Builder
	for _, it := range items {
		b.WriteString("  " + it.Type + ": " + it.Content + "\n")
	}
	return b.String()
}
