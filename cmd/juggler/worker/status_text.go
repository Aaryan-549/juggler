//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"time"

	"juggler/cmd/juggler/msg"
)

// noModelWarning is the composer warning for a send, or a continue, with no
// model selected.
func noModelWarning(continuation bool) msg.Message {
	if continuation {
		return msg.New("Please select a model before continuing")
	}
	return msg.New("Please select a model before sending a message")
}

// providerUnavailableWarning says the selected model's provider can't be used,
// naming the model when it is known, with the resolver's own account of why as
// data after it.
func providerUnavailableWarning(mc *ModelConfig, detail string) msg.Message {
	hasDetail := "no"
	if detail != "" {
		hasDetail = "yes"
	}
	if mc == nil {
		return msg.New("The selected model's provider can't be used. Pick another model, or configure it in settings.{hasDetail, select, yes {\n\n{detail}} other {}}",
			"hasDetail", hasDetail, "detail", detail)
	}
	return msg.New("The provider for {model} ({provider}) can't be used. Pick another model, or configure {provider} in settings.{hasDetail, select, yes {\n\n{detail}} other {}}",
		"model", mc.Model, "provider", mc.Provider, "hasDetail", hasDetail, "detail", detail)
}

// malformedMessageError reports an inbound frame of type kind that did not
// parse. The two kinds keep the English each has always had.
func malformedMessageError(kind string) msg.Message {
	if kind == "init" {
		return msg.New("Failed to parse init message")
	}
	return msg.New("Failed to parse send-message")
}

// conversationNotFoundError reports a conversation whose stored data could not
// be loaded, with the store's own error as data.
func conversationNotFoundError(err error) msg.Message {
	return msg.New("Conversation data not found: {detail}", "detail", err.Error())
}

// threadNotFoundError reports a send addressed to a thread the doc has no item for.
func threadNotFoundError(id string) msg.Message {
	return msg.New("Thread item {id} not found", "id", id)
}

// notSignedInReport is the error item for a provider that refused a call on
// authentication grounds and gave no hint: Juggler's lead, then the
// provider's own account as data.
func notSignedInReport(detail string) msg.Message {
	return msg.New("The provider isn't signed in.{hasDetail, select, yes {\n\n{detail}} other {}}",
		"hasDetail", yesNo(detail != ""), "detail", detail)
}

// notSetUpReport is notSignedInReport for a provider that can't run on this
// machine.
func notSetUpReport(detail string) msg.Message {
	return msg.New("The provider isn't set up on this machine.{hasDetail, select, yes {\n\n{detail}} other {}}",
		"hasDetail", yesNo(detail != ""), "detail", detail)
}

// retryParams are the values every retrying status takes: the attempt, the
// most there will be, and — once a minute or more has gone on retries — how
// long, which the status then says.
func retryParams(attempt, max int, spent time.Duration) []any {
	hasSpent, said := "no", ""
	if spent >= time.Minute {
		hasSpent, said = "yes", spent.Round(time.Second).String()
	}
	return []any{"attempt", attempt, "max", max, "hasSpent", hasSpent, "spent", said}
}
