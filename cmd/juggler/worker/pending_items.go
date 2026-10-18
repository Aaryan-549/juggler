//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	ycrdt "github.com/skyterra/y-crdt"
)

// Queued (pending) messages — "type while busy".
//
// A message sent while a turn is already in flight is not dropped: it is parked
// in a `pendingItems` Y.Array hung off the same parent map that owns `items`
// (the doc root for the root thread, the thread Y.Map for a sub-thread). Because
// it is a sibling of `items` it is NEVER seen by the reducer or the LLM context
// builder until it is promoted.
//
// `promotePendingItems` is the single transition: it moves the queued entries
// into `items` as real user messages (chronologically last) and clears the
// queue. The strategy loop drains at the turn boundary and at end-of-run (drive
// a new turn). On cancel the behaviour splits: when the turn was blocked purely
// by tool approvals, dropping them continues the queued turn (reducer ActionGoIdle
// → dispatch); when real work was executing, Stop promotes the queue and parks
// at idle. All paths call the same primitive — only the continuation differs.

// pendingParentMapLocked returns the Y.Map that owns the pendingItems array for
// the given thread ("" => root). Caller MUST hold ycrdtMu.
func (cd *ConversationDocument) pendingParentMapLocked(threadItemID string) *ycrdt.YMap {
	if threadItemID == "" {
		return cd.root
	}
	return findThreadYMap(cd.getItems(), threadItemID)
}

// getPendingArrayLocked returns the existing pendingItems array for the thread,
// or nil if none has been created. Caller MUST hold ycrdtMu.
func (cd *ConversationDocument) getPendingArrayLocked(threadItemID string) *ycrdt.YArray {
	parent := cd.pendingParentMapLocked(threadItemID)
	if parent == nil {
		return nil
	}
	if arr, ok := parent.Get("pendingItems").(*ycrdt.YArray); ok {
		return arr
	}
	return nil
}

// ensurePendingArrayLocked get-or-creates the pendingItems array on the parent
// map for the thread. Caller MUST hold ycrdtMu. Returns nil if the thread is gone.
func (cd *ConversationDocument) ensurePendingArrayLocked(threadItemID string) *ycrdt.YArray {
	parent := cd.pendingParentMapLocked(threadItemID)
	if parent == nil {
		return nil
	}
	if arr, ok := parent.Get("pendingItems").(*ycrdt.YArray); ok {
		return arr
	}
	arr := ycrdt.NewYArray()
	cd.doc.Transact(func(_ *ycrdt.Transaction) {
		parent.Set("pendingItems", arr)
	}, cd.txOrigin())
	return arr
}

// appendPendingItem appends one item to the end of the thread's pending queue,
// creating the queue if the thread hasn't got one yet. Reports false (and
// writes nothing) when the thread is gone. Untracked (txOrigin): the queue is
// plumbing the strategy loop drains, not an undoable edit — the promotion into
// the thread is what the user undoes.
func (w *ConversationWorker) appendPendingItem(threadItemID string, item ConversationItem) bool {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	arr := w.doc.ensurePendingArrayLocked(threadItemID)
	if arr == nil {
		return false
	}
	w.appendPendingItemsLocked(arr, item)
	return true
}

// appendPendingItemsLocked appends items, in order, to a pending queue in one
// untracked transaction. Caller MUST hold ycrdtMu.
func (w *ConversationWorker) appendPendingItemsLocked(arr *ycrdt.YArray, items ...ConversationItem) {
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		for _, item := range items {
			arr.Insert(arr.GetLength(), ycrdt.ArrayAny{conversationItemToYMap(item)})
		}
	}, w.doc.txOrigin())
}

// queueIfBusy is the intake gate and the enqueue in one hold: it reports whether
// threadItemID is busy (threadBusy) and, when it is, appends what build returns
// to its pending queue. build runs only for a busy thread, under ycrdtMu, so it
// must not take the lock. queued is false when build returned nothing or the
// thread is gone.
//
// One hold because the turn that makes the thread busy can end between a
// separate check and the append. It decides to stop with its queue empty, then
// releases its claim. A message that saw the claim and was appended after that
// decision would sit in the queue under an idle thread, with no boundary left to
// drain it. Here the append either lands before the release, where the turn's
// last look (requestLLMIfQueued) finds it, or the gate sees the thread idle and
// the send takes the idle path itself.
func (w *ConversationWorker) queueIfBusy(threadItemID string, build func() []ConversationItem) (busy, queued bool) {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	if !w.threadBusyLocked(threadItemID) {
		return false, false
	}
	items := build()
	if len(items) == 0 {
		return true, false
	}
	arr := w.doc.ensurePendingArrayLocked(threadItemID)
	if arr == nil {
		return true, false
	}
	w.appendPendingItemsLocked(arr, items...)
	return true, true
}

// enqueuePendingMessage appends a user message (text + attachments, as one
// inseparable unit) to the thread's pending queue. The strategy loop drains the
// queue at its next boundary, promoting the item verbatim — attachments
// included. Intake asks queueIfBusy instead, which decides and appends in one
// hold.
func (w *ConversationWorker) enqueuePendingMessage(threadItemID string, input UserMessageInput) {
	if input.isEmpty() {
		return
	}
	item := newUserItem(input)
	if !w.appendPendingItem(threadItemID, item) {
		return
	}
	w.recordPendingEnqueue(threadItemID, item.ItemID)
}

// recordPendingEnqueue tapes a queued user message and flushes, so the queued
// bubble surfaces in the UI immediately.
func (w *ConversationWorker) recordPendingEnqueue(threadItemID, itemID string) {
	w.tape.Record("pending-enqueue", map[string]any{
		"threadItemId": threadItemID,
		"itemId":       itemID,
	})
	w.batcher.Flush()
}

// requestLLMIfQueued queues threadItemID for dispatch when its pending queue
// holds anything, reading the queue and writing the claim in one hold. It is a
// finishing run's last look at its own thread, taken after its claim is
// released and its idle frame is out: from then on the intake gate sees the
// thread idle, so nothing can be queued there that this look misses (see
// queueIfBusy). Reports whether it queued a dispatch.
func (w *ConversationWorker) requestLLMIfQueued(threadItemID string) bool {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	arr := w.doc.getPendingArrayLocked(threadItemID)
	if arr == nil || arr.GetLength() == 0 {
		return false
	}
	return w.patchRunIfLocked(threadItemID,
		func(entry map[string]any) bool { return entryActivity(entry) != ActivityCallingLLM },
		func(entry, _ map[string]any) { entry["activity"] = ActivityAwaitingLLM },
	)
}

// HasPendingItems reports whether the thread ("" => root) has any queued
// (not-yet-promoted) messages. Exported for test observability so a test can
// deterministically wait for a busy-time send to land in the queue before
// releasing the in-flight turn.
func (w *ConversationWorker) HasPendingItems(threadItemID string) bool {
	return w.hasPendingItems(threadItemID)
}

// hasPendingItems reports whether the thread has any queued messages.
func (w *ConversationWorker) hasPendingItems(threadItemID string) bool {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	arr := w.doc.getPendingArrayLocked(threadItemID)
	return arr != nil && arr.GetLength() > 0
}

// promotePendingItems moves every queued message for the thread into its items
// array as a user message (chronologically last) and clears the queue. The
// promoted items are left UNSTAMPED (no transactionId) so the strategy loop's
// findUnstampedUserMsgID picks up the last one for the next round-trip. Returns
// the number promoted. The move itself, and why it is one hold, is
// OperationTracker.PromotePending.
func (r *run) promotePendingItems(threadItemID string) int {
	pending := r.tracker.PromotePending(threadItemID)
	if len(pending) == 0 {
		return 0
	}

	r.tape.Record("pending-promote", map[string]any{
		"threadItemId": threadItemID,
		"count":        len(pending),
	})
	r.batcher.Flush()
	r.handleItemsChange()
	return len(pending)
}

// collectPendingAssetIDsLocked adds every asset id referenced by a QUEUED
// (pending) user message — the root queue and every thread container's queue —
// to dst. A queued message lives in a `pendingItems` sibling array, NOT in
// `items`, so the committed-item walk in collectAssetIDsFromItems never sees it;
// without this a queued attachment's bytes could be reclaimed by the asset sweep
// before the message is promoted, landing a broken image. Mirrors
// collectDraftAssetIDsLocked. Caller MUST hold ycrdtMu.
func (cd *ConversationDocument) collectPendingAssetIDsLocked(dst map[string]bool) {
	collectPendingAssetIDsFromMap(cd.root, dst)
	if arr := cd.getItems(); arr != nil {
		collectPendingAssetIDsFromArray(arr, dst)
	}
}

// collectPendingAssetIDsFromMap adds the attachment ids of every queued user
// item in the parent map's pendingItems array to dst. Callers MUST hold ycrdtMu.
func collectPendingAssetIDsFromMap(parent *ycrdt.YMap, dst map[string]bool) {
	if parent == nil {
		return
	}
	arr, ok := parent.Get("pendingItems").(*ycrdt.YArray)
	if !ok {
		return
	}
	length := int(arr.GetLength())
	for i := 0; i < length; i++ {
		m, ok := arr.Get(ycrdt.Number(i)).(*ycrdt.YMap)
		if !ok {
			continue
		}
		for _, att := range yMapToConversationItem(m).Attachments {
			if att.ID != "" {
				dst[att.ID] = true
			}
		}
	}
}

// collectPendingAssetIDsFromArray walks an items Y.Array (recursing into each
// thread's nested "items") collecting each thread container's queued-attachment
// ids. Callers MUST hold ycrdtMu.
func collectPendingAssetIDsFromArray(arr *ycrdt.YArray, dst map[string]bool) {
	length := int(arr.GetLength())
	for i := 0; i < length; i++ {
		m, ok := arr.Get(ycrdt.Number(i)).(*ycrdt.YMap)
		if !ok {
			continue
		}
		collectPendingAssetIDsFromMap(m, dst)
		if nested, ok := m.Get("items").(*ycrdt.YArray); ok {
			collectPendingAssetIDsFromArray(nested, dst)
		}
	}
}

// clearPendingItems empties the thread's pending queue without promoting. Used
// by /clear, the one thread-wide mutator that must remember the staging array.
func (w *ConversationWorker) clearPendingItems(threadItemID string) {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	arr := w.doc.getPendingArrayLocked(threadItemID)
	if arr == nil {
		return
	}
	length := int(arr.GetLength())
	if length == 0 {
		return
	}
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		arr.Delete(ycrdt.Number(0), length)
	}, w.doc.txOrigin())
	w.log.Info("Cleared %d pending message(s) for thread %q", length, threadItemID)
}
