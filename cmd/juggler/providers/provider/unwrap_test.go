//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package provider

import (
	"context"
	"testing"
)

type baseOnlyProvider struct{}

func (baseOnlyProvider) Name() string { return "base-only" }
func (baseOnlyProvider) ListModelsWithInfo(context.Context) ([]ModelInfo, error) {
	return nil, nil
}

type usageOnlyProvider struct{ baseOnlyProvider }

func (usageOnlyProvider) UsageStats(context.Context) (UsageStats, error) {
	return UsageStats{Provider: "usage"}, nil
}

type chatProvider struct{ baseOnlyProvider }

func (chatProvider) OpenConversation(context.Context, string) (Conversation, error) {
	return nil, nil
}

func TestAsFindsCapabilityThroughAdmissionWrapper(t *testing.T) {
	wrapped := &admissionProvider{Provider: usageOnlyProvider{}}
	usage, ok := As[UsageStatsProvider](wrapped)
	if !ok {
		t.Fatal("As did not find UsageStatsProvider under the wrapper")
	}
	stats, err := usage.UsageStats(context.Background())
	if err != nil || stats.Provider != "usage" {
		t.Fatalf("UsageStats = %+v, %v", stats, err)
	}
}

func TestAsReportsMissingCapability(t *testing.T) {
	if _, ok := As[UsageStatsProvider](&admissionProvider{Provider: baseOnlyProvider{}}); ok {
		t.Fatal("As found UsageStatsProvider on a provider without it")
	}
	if _, ok := As[UsageStatsProvider](nil); ok {
		t.Fatal("As found a capability on a nil provider")
	}
}

func TestAsConversationProviderReturnsAdmissionWrapper(t *testing.T) {
	wrapped := &admissionProvider{Provider: chatProvider{}}
	cp, ok := AsConversationProvider(wrapped)
	if !ok {
		t.Fatal("wrapped chat provider not found")
	}
	if cp != ConversationProvider(wrapped) {
		t.Fatalf("AsConversationProvider returned %T, want the admission wrapper", cp)
	}
}

func TestOpenConversationRejectsNonChatProvider(t *testing.T) {
	wrapped := &admissionProvider{Provider: baseOnlyProvider{}}
	if _, ok := AsConversationProvider(wrapped); ok {
		t.Fatal("non-chat provider reported as conversation provider")
	}
	if _, err := OpenConversation(context.Background(), wrapped, "c"); err == nil {
		t.Fatal("OpenConversation succeeded on a provider that cannot chat")
	}
}
