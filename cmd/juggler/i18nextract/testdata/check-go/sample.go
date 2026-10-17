package sample

import "juggler/cmd/juggler/msg"

var (
	_ = msg.New("Greeted {name}", "name", "x")
	_ = msg.New("Saved")
)
