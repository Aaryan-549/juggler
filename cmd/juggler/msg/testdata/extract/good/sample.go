package sample

import "juggler/cmd/juggler/msg"

var host = "example.com"

var (
	_ = msg.New("Plain")
	_ = msg.New("Model {name} not found", "name", "x")
	_ = msg.New("Tab\there \"quoted\" caf\u00e9 \xc3\xa9 \101 \U0001F600")
	_ = msg.New(`raw {path} \n stays`)
	_ = msg.New("split " +
		"across lines")
	_ = msg.NewCtx("verb", "Open")
	_ = msg.NewError("Cannot reach {host}", "host", host)
	_ = msg.New(
		"newline after paren",
	)
	// msg.New("in a comment") is not a message.
	/* msg.New("nor in a block comment") */
	_ = "msg.New(\"inside a string\")"
	_ = `msg.New("inside a raw string")`
	_ = '"'
	_ = msg.New("after a rune")
)
