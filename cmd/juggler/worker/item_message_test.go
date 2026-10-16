//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"testing"
	"time"

	"juggler/cmd/juggler/msg"
)

// dataMessage decodes the message an item's Data carries under field —
// "message" for the one that renders Content, "summaryMessage" for the one that
// renders Summary — or the zero Message when it carries none.
func dataMessage(t *testing.T, item ConversationItem, field string) msg.Message {
	t.Helper()
	if len(item.Data) == 0 {
		return msg.Message{}
	}
	var data map[string]json.RawMessage
	if err := json.Unmarshal(item.Data, &data); err != nil {
		t.Fatalf("item data %s: %v", item.Data, err)
	}
	var m msg.Message
	if raw, ok := data[field]; ok {
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Fatalf("item data %s %s: %v", field, raw, err)
		}
	}
	return m
}

// assertItemMessage checks that item's Data carries under field a message with
// key wantKey whose English is exactly want — the text stored beside it, so an
// item drawn by a client that translates nothing still reads as it always did.
func assertItemMessage(t *testing.T, item ConversationItem, field, wantKey, want string) {
	t.Helper()
	m := dataMessage(t, item, field)
	if m.Key != wantKey {
		t.Fatalf("data.%s key = %q, want %q", field, m.Key, wantKey)
	}
	if got := m.English(); got != want {
		t.Errorf("data.%s renders %q, want the stored English %q", field, got, want)
	}
}

// assertNoticeMessages checks that a notice carries both its messages and that
// each renders, in English, exactly the text stored beside it; it returns them.
func assertNoticeMessages(t *testing.T, item ConversationItem) (summary, content msg.Message) {
	t.Helper()
	summary, content = dataMessage(t, item, "summaryMessage"), dataMessage(t, item, "message")
	if summary.IsZero() || content.IsZero() {
		t.Fatalf("notice data %s, want both summaryMessage and message", item.Data)
	}
	if got := summary.English(); got != item.Summary {
		t.Errorf("summaryMessage renders %q, want the stored summary %q", got, item.Summary)
	}
	if got := content.English(); got != item.Content {
		t.Errorf("message renders %q, want the stored content %q", got, item.Content)
	}
	return summary, content
}

// TestErrorItemCarriesItsMessage: an error Juggler words itself is stored with
// the message it was rendered from, raw text riding as a param, and its
// Content and Summary in English exactly as before.
func TestErrorItemCarriesItsMessage(t *testing.T) {
	w := NewConversationWorker("conv-error-message", "user:test")
	defer w.doc.Destroy()

	report := turnPanicMessage("boom")
	w.currentRun().sendErrorWithData(report.English(), &report, "", map[string]any{"errorKind": "auth"})

	items := w.doc.GetItems()
	item := items[len(items)-1]
	const want = "Internal error: this turn crashed and was stopped (boom). The conversation is safe to continue."
	if item.Type != ItemTypeError || item.Content != want || item.Summary != want {
		t.Fatalf("error item = %s %q / %q, want %q", item.Type, item.Content, item.Summary, want)
	}
	assertItemMessage(t, item, "message",
		"Internal error: this turn crashed and was stopped ({detail}). The conversation is safe to continue.", want)
	if m := dataMessage(t, item, "message"); m.Params["detail"] != "boom" {
		t.Errorf("params = %v, want the panic value as detail", m.Params)
	}
	var data map[string]any
	_ = json.Unmarshal(item.Data, &data)
	if data["errorKind"] != "auth" {
		t.Errorf("data = %v, lost the caller's errorKind", data)
	}
}

// TestRawErrorItemCarriesNoMessage: text that is only data — a provider's own
// error — is stored as it always was, with nothing to translate.
func TestRawErrorItemCarriesNoMessage(t *testing.T) {
	w := NewConversationWorker("conv-raw-error", "user:test")
	defer w.doc.Destroy()

	w.currentRun().sendErrorWithData("LLM error: 500 upstream", nil, "", nil)
	items := w.doc.GetItems()
	item := items[len(items)-1]
	if item.Content != "LLM error: 500 upstream" || len(item.Data) != 0 {
		t.Fatalf("raw error item = %q data %s, want the text and no data", item.Content, item.Data)
	}
}

// TestRateLimitReportIsOneMessage: the lead and the provider's detail are one
// message, the detail a param, so a translation can place it.
func TestRateLimitReportIsOneMessage(t *testing.T) {
	now := time.Date(2026, 9, 10, 19, 58, 0, 0, time.UTC)
	m := rateLimitReport("", now.Add(25*time.Minute), now, "429 Too Many Requests")
	want := "The provider has reached its usage limit. It resets in about 25 minutes, at 20:23.\nNothing here will call it again until then — send again to try anyway.\n\n429 Too Many Requests"
	if got := m.English(); got != want {
		t.Fatalf("report = %q, want %q", got, want)
	}
	if m.Params["detail"] != "429 Too Many Requests" {
		t.Errorf("params = %v, want the provider text as detail", m.Params)
	}
}

// TestErrorAndNoticeMessagesStayOffTheWire: a message in Data changes nothing
// the model sees — both item types still contribute no wire message.
func TestErrorAndNoticeMessagesStayOffTheWire(t *testing.T) {
	data, _ := json.Marshal(map[string]any{
		"message":        msg.New("Folded {count} earlier items", "count", 3),
		"summaryMessage": msg.New("Folded"),
	})
	for _, typ := range []string{ItemTypeError, ItemTypeNotice} {
		item := ConversationItem{Type: typ, ItemID: "I_1", Summary: "Folded", Content: "Folded 3 earlier items", Data: data}
		if msgs := itemWireMessages(item, []ConversationItem{item}); msgs != nil {
			t.Errorf("%s item with a message emitted %d wire message(s), want none: %+v", typ, len(msgs), msgs)
		}
	}
}
