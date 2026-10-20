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

// requireAdmissionChecked fails unless cp opens conversations that check each
// request against the context window — the guarantee As must not unwrap past.
func requireAdmissionChecked(t *testing.T, cp ConversationProvider) {
	t.Helper()
	conv, err := cp.OpenConversation(context.Background(), "c")
	if err != nil {
		t.Fatal(err)
	}
	if _, checked := conv.(*admissionConversation); !checked {
		t.Fatalf("opened %T, want an admission-checked conversation", conv)
	}
}

func TestAsConversationProviderIsAdmissionChecked(t *testing.T) {
	cp, ok := As[ConversationProvider](&admissionProvider{Provider: chatProvider{}})
	if !ok {
		t.Fatal("As did not find ConversationProvider under the wrapper")
	}
	requireAdmissionChecked(t, cp)
}

func TestAsReportsNoConversationsForNonChatProvider(t *testing.T) {
	wrapped := &admissionProvider{Provider: baseOnlyProvider{}}
	if _, ok := As[ConversationProvider](wrapped); ok {
		t.Fatal("As found ConversationProvider on a provider that cannot chat")
	}
	if _, err := OpenConversation(context.Background(), wrapped, "c"); err == nil {
		t.Fatal("OpenConversation succeeded on a provider that cannot chat")
	}
}

func TestInitializeProviderExposesUsageStatsAndConversations(t *testing.T) {
	const name = "unwrap-test-usage-chat"
	RegisterProvider(ProviderInfo{Name: name}, func(Config) (Provider, error) {
		return usageChatProvider{}, nil
	})
	t.Cleanup(func() { UnregisterProvider(name) })

	initialized, err := InitializeProvider(name, Config{Model: "m"})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := As[UsageStatsProvider](initialized); !ok {
		t.Fatal("usage stats not reachable through the admission wrapper")
	}
	cp, ok := As[ConversationProvider](initialized)
	if !ok {
		t.Fatal("conversations not reachable through the admission wrapper")
	}
	requireAdmissionChecked(t, cp)
}

type usageChatProvider struct{ baseOnlyProvider }

func (usageChatProvider) UsageStats(context.Context) (UsageStats, error) { return UsageStats{}, nil }
func (usageChatProvider) OpenConversation(context.Context, string) (Conversation, error) {
	return nil, nil
}
