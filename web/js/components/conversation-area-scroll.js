//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * conversation-area-scroll — the scroll controller for conversation-area.js.
 *
 * One {@link ColumnScroll} per column, owning every piece of scroll state the
 * column has: the coalesced scroll-to-bottom frame, the once-per-load restore,
 * the sub-thread landing owed, the reader anchor, the window in which a scroll
 * this column asked for is still travelling, and the scroll-to-top/bottom
 * controls. It reaches the column only through the column's public surface (its
 * DOM, `conversation`, `getMessageThread()`, `displayIdFor()`,
 * `getSelectedItemId()`, `selectionOrigin`, `getSelectableItemIds()`) and binds
 * its listeners through the column's JugglerElement helpers, so they go when the
 * column leaves the document and come back with it.
 *
 * All scrolling is direct, clamped scrollTop math against the #message-list
 * (endIntoView / elementIntoView), not Element.scrollIntoView: scrollTop is
 * container-scoped and auto-clamped to [0, scrollHeight - clientHeight], so it
 * can neither overshoot nor scroll a parent (e.g. the horizontal column
 * container) as a side effect. The list wrapper never overlaps the composer, so
 * the one correct "end of conversation" position is simply scrollTop = 0 in the
 * column-reverse scroller, which clamps to "end of content at the bottom edge,
 * above the box". Selecting the tail item and every follow-target update share
 * that path.
 *
 * UX rules 6-11 (numbering continues the selection rules in
 * conversation-area-selection.js, which drives most of these):
 *   6/7. Selection (user or auto) of an item → bring the item fully into view
 *      with minimal, clamped movement (elementIntoView). The tail item routes
 *      to endIntoView (it IS the end).
 *   8. New items arrive but none auto-selected → scroll the follow target
 *      (status spinner or footer) into view, if near bottom.
 *   8b. The reader's own message arrives → show it, from wherever they were
 *      reading (userSendIntoView). This is the one move no gate may veto:
 *      sending is an explicit request to see the result.
 *   9. Streaming content grows → keep follow target visible, but only while the
 *      user was already near bottom.
 *  10. LLM busy indicator appears → no code: it lands at the end, where native
 *      column-reverse anchoring keeps it in view for a reader following there.
 *  11. User scrolls far from the bottom (>~20rem) → stop auto-scrolling. No
 *      fighting. Scrolling near the bottom (~20rem) allows auto-scrolling to
 *      continue — unless a row in this column is pinned, which says a reader is
 *      here without their having scrolled anywhere (rule 4, see
 *      isFollowingEnd). Both questions are asked together, because being parked
 *      at the end is only evidence that nobody is reading when nothing is
 *      pinned. This governs every AUTOMATIC move, including auto-selection
 *      (rule 4b in conversation-area-selection.js): a selection the system
 *      makes may scroll only while the reader is at the end, because scrolling
 *      away is the whole instruction. Passing that gate authorises following
 *      the conversation, never leaving it, so an automatic move is barred from
 *      travelling away from the end as well (elementIntoView) — the direction
 *      the rule exists to protect is the one a "minimal movement" scroll will
 *      happily take to frame a tall item. The reader's own actions are not
 *      automatic moves and are never gated by any of this — selecting an item
 *      (rules 6-7) and sending a message (rule 8b) both scroll from wherever the
 *      view happens to be. What holds the reader's place against content
 *      arriving below them is the reader anchor at the end of this class — held
 *      across a streaming bubble's growth and a structural insert
 *      (holdAnchorOver), and by an observer for whatever arrives outside both.
 *
 *  12. A column is pointed at a sub-thread → land on the START of that thread's
 *      last message, when the message is too tall to fit (restore,
 *      lastMessageStartIntoView). Opening a finished thread is an instruction
 *      to read what it came back with, and the end of a long answer is the one
 *      part of it the reader has no use for yet. A thread still being driven
 *      keeps the ordinary landing at the end, where its next token appears —
 *      there is nothing finished to read there. The landing leaves the view
 *      outside rule 11's near-bottom band with auto-follow stood down, which is
 *      what a thread nothing is writing to wants, and is the second reason a
 *      busy one is excluded.
 *
 * The follow target (see followTarget) always sits at the end of the
 * conversation, in priority order:
 *   selected busy thread > any busy thread > footer spinner > footer.
 *   Revealing any of them is the same endIntoView call.
 *
 * A selection scroll is re-asserted one frame later (see ColumnSelection's
 * select): the selection triggers a column rebuild whose own rAF callbacks would
 * otherwise perturb scrollTop right after our scroll. Chrome's scroll anchoring
 * hid that; Safari (which has none) showed it as a just-selected tail item
 * jumping down behind the composer. The re-assert makes our scroll the final
 * word.
 *
 * The one call back into the selection engine (the tail test in itemIntoView)
 * goes through the column's public `getSelectableItemIds()`, so this module has
 * no import cycle with its counterpart.
 * @module components/conversation-area-scroll
 */

import { saveScrollState, getScrollState } from '../utils/scroll-persistence.js';
import { MESSAGE_TAGS } from './conversation-area-rendering.js';

/**
 * Idle gap (ms) after a scroll this column asked for stops moving before the
 * reader anchor takes charge of the view again. Comfortably longer than the frame
 * gap of a smooth scroll, so a glide still in flight keeps pushing it out. See
 * beginProgrammaticScroll.
 */
const PROGRAMMATIC_SCROLL_SETTLE_MS = 150;

/** "Long enough to be useful" — a thread that barely overflows shows no scroll controls. */
const USEFUL_OVERFLOW_PX = 48;

/**
 * A scroll control hides once the view is within this of its end — close enough
 * that a flick finishes the trip.
 */
const CONTROL_EDGE_PX = 32;

/**
 * @typedef {object} ReaderAnchor
 * @property {HTMLElement} el - The row the reader's place is measured from.
 * @property {number} top - Where that row sat when last recorded.
 * @property {number} contentHeight - The content height it was recorded against.
 */

/**
 * The scroll controller for one conversation column.
 */
export class ColumnScroll {
  /**
   * @param {any} area - The ConversationArea this controls.
   */
  constructor(area) {
    /** @type {any} @private */
    this._area = area;
    /** @type {number|null} @private - The coalesced scroll-to-bottom frame (toBottom) */
    this._frame = null;
    /** @type {boolean} @private - The once-per-load restore has happened */
    this._restored = false;
    /** @type {boolean} @private - The column has been pointed at a sub-thread it has yet to land on (rule 12) */
    this._landingPending = false;
    /** @type {ReaderAnchor|null} @private - The reader's place, while they sit away from the end */
    this._anchor = null;
    /** @type {boolean} @private - A scroll this column asked for is still travelling (beginProgrammaticScroll) */
    this._programmatic = false;
    /** @type {number|null} @private - Settle timer that ends the programmatic-scroll window */
    this._settleTimer = null;
  }

  /**
   * @returns {HTMLElement|null} The reversed scroller.
   * @private
   */
  get _list() {
    return /** @type {HTMLElement|null} */ (this._area.querySelector('#message-list'));
  }

  /**
   * @returns {HTMLElement|null} The normal-order content column inside it.
   * @private
   */
  get _content() {
    return /** @type {HTMLElement|null} */ (this._area.querySelector('#message-list-inner'));
  }

  /**
   * The reader's place, while one is held. Read by tests; nothing else needs it.
   * @returns {ReaderAnchor|null} The anchor, or null near the end.
   */
  get anchor() {
    return this._anchor;
  }

  /** @returns {boolean} True while a scroll this column asked for is still travelling. */
  get programmatic() {
    return this._programmatic;
  }

  /**
   * Bind the scroll controls, the scroll listener and the reader-anchor observer
   * to the column's current DOM. Called on every connect: everything bound here
   * goes through the column's JugglerElement helpers, so the disconnect releases
   * it, along with the frame and the settle timer still pending.
   *
   * Wires the subtle scroll-to-top / scroll-to-bottom controls overlaid on the
   * top-right of the message list. Each button smooth-scrolls to its end and is
   * shown only when the list overflows AND there's further to travel in that
   * direction (so a short, fully-visible thread shows neither, and the end you're
   * already at hides its own button). Visibility is recomputed on scroll and on
   * any size change of the viewport or its content.
   */
  attach() {
    const area = this._area;
    area.addCleanup(() => this._release());
    const messageList = this._list;
    const controls = /** @type {HTMLElement|null} */ (area.querySelector('#scroll-controls'));
    if (!messageList || !controls) return;

    const top = controls.querySelector('[data-scroll="top"]');
    if (top) {
      area.on(top, 'click', (/** @type {Event} */ e) => {
        e.stopPropagation();
        this.toConversationStart();
      });
    }
    const bottom = controls.querySelector('[data-scroll="bottom"]');
    if (bottom) {
      area.on(bottom, 'click', (/** @type {Event} */ e) => {
        e.stopPropagation();
        this.beginProgrammaticScroll();
        this.endIntoView(true);
      });
    }

    area.on(messageList, 'scroll', () => {
      this.updateControls();
      // Wherever the reader has just put the view is their place to hold — unless
      // this scroll is one we asked for, which owns the view until it lands.
      if (this._programmatic) this._armSettle();
      else this._recordAnchorFromScroll();
    }, { passive: true });

    if (typeof ResizeObserver !== 'undefined') {
      // Recompute on content growth (streaming, inserts) and viewport resize, both
      // of which change whether — and how far — the list can scroll.
      const controlsObserver = new ResizeObserver(() => this.updateControls());
      controlsObserver.observe(messageList);
      const inner = this._content;
      if (inner) controlsObserver.observe(inner);
      area.addCleanup(() => controlsObserver.disconnect());
    }

    this.updateControls();
    this._attachReaderAnchor();
  }

  /**
   * Drop what outlives a disconnect on its own: the queued scroll-to-bottom
   * frame, the settle timer, and the reader's place, which was a place in a
   * layout the column is no longer part of.
   * @private
   */
  _release() {
    if (this._frame !== null) {
      cancelAnimationFrame(this._frame);
      this._frame = null;
    }
    if (this._settleTimer !== null) {
      clearTimeout(this._settleTimer);
      this._settleTimer = null;
    }
    this._programmatic = false;
    this._anchor = null;
  }

  // ── Selection scrolls (rules 6-7) ────────────────────────────────

  /**
   * Rules 6–7: Scroll a selected item into view (minimal movement).
   * Used for user-initiated and auto selection.
   *
   * Selecting the TAIL item means "show me the end of the conversation", so it
   * routes through the one layout-guaranteed scroll (endIntoView) — the footer,
   * and the composer just below it, pinned to the bottom of the viewport. Any
   * other item gets a minimal, clamped scroll. Neither path uses scrollIntoView,
   * whose ancestor-walking + nearest/end alignment guesswork is exactly what
   * parked the footer past the scroll clamp and shoved the clicked item behind
   * the (tall) composer.
   * `smooth` only applies to the tail/end path (the auto-follow case); a non-tail
   * item gets the same minimal, instant nudge regardless — it's inspection, not
   * an end-follow.
   * @param {string} itemId
   * @param {{smooth?: boolean, automatic?: boolean}} [opts] - `smooth` glides the
   *   tail/end path. `automatic` marks a move the system decided on rather than
   *   one the reader asked for, which rule 11 holds to the end of the
   *   conversation (see elementIntoView).
   */
  itemIntoView(itemId, { smooth = false, automatic = false } = {}) {
    const messageList = this._list;
    if (!messageList) return;
    itemId = this._area.displayIdFor(itemId);
    const el = messageList.querySelector(`[message-id="${itemId}"]`);
    if (!el) return;
    // Detect the tail by SELECTABLE order, not DOM adjacency: a
    // `nextElementSibling === footer` test misfires when a non-selectable
    // trailing element (e.g. a transaction marker) sits between the last
    // selectable item and the footer, which would route a tail selection to the
    // minimal-scroll path instead of the scroll-to-end path.
    const ids = this._area.getSelectableItemIds();
    if (ids.length > 0 && ids[ids.length - 1] === itemId) {
      this.endIntoView(smooth);
      return;
    }
    this._elementIntoView(el, automatic);
  }

  /**
   * The single layout-guaranteed scroll: pin the END of all content (the whole
   * footer, plus any queued-message bubbles rendered below it) to the bottom of
   * the message-list viewport. The scroller is column-reverse, so the content
   * end sits at the flex-start edge and "scroll to the end" is simply
   * scrollTop = 0 — clamped by construction, it can neither overshoot nor scroll
   * an ancestor. This is the consistent code-path for "scroll the end of the
   * conversation into view", shared by tail selection and follow-target updates.
   * No scrollIntoView.
   *
   * `smooth` animates the move (used when auto-following the growing end of the
   * conversation), riding the scroller's `scroll-behavior: smooth`. Selection
   * passes `false` to override that with an instant scroll, where a glide would
   * read as lag.
   * @param {boolean} [smooth=false]
   */
  endIntoView(smooth = false) {
    const messageList = this._list;
    if (!messageList) return;
    // Reversed scroller: the end of the content sits at the flex-start edge, so
    // "scroll to the end of the conversation" is simply scrollTop = 0 — clamped
    // by construction, it can neither overshoot nor scroll an ancestor. The glide
    // comes from the scroller's CSS scroll-behavior; `instant` opts out per-call.
    messageList.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'instant' });
  }

  /**
   * Minimal-movement scroll to bring an element fully into the message-list
   * viewport. Scrolls ONLY the message-list — assigning scrollTop auto-clamps to
   * [0, scrollHeight − clientHeight], so nothing can be driven past the end —
   * never scrollIntoView (which would also scroll ancestors and guess an edge).
   * @param {Element} el
   * @param {boolean} [automatic=false] - True when the system chose this move, so
   *   rule 11 bars it from travelling away from the end.
   * @private
   */
  _elementIntoView(el, automatic = false) {
    const messageList = this._list;
    if (!messageList) return;
    const listRect = messageList.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    let delta = 0;
    if (elRect.top < listRect.top) delta = -(listRect.top - elRect.top);
    else if (elRect.bottom > listRect.bottom) delta = elRect.bottom - listRect.bottom;
    if (delta === 0) return;
    // Relative nudge: `delta` comes from viewport rects (direction-agnostic), and
    // in the reversed scroller scrollTop increases toward the content end exactly
    // as it does in a normal column, so the same offset brings the element into
    // view. Clamped, so it can't overshoot. Instant (overriding the scroller's
    // scroll-behavior: smooth) — selection inspection shouldn't glide.
    const next = messageList.scrollTop + delta;
    // Rule 11: an automatic move may not take the view further from the end than
    // it already is. An item taller than the viewport is brought "fully into
    // view" by showing its TOP, and for a reader following the end that is a
    // scroll backwards — away from the content they are there to watch, and far
    // enough (the item's overhang) to leave the near-bottom band, after which the
    // reader anchor holds them there and the turn finishes offscreen. Following
    // the end outranks framing the item the system happened to pick; the reader's
    // own selection is not automatic and still scrolls wherever it must.
    // Distance from the end is |scrollTop| in the reversed scroller, so comparing
    // magnitudes is the sign-agnostic form of "further away".
    if (automatic && Math.abs(next) > Math.abs(messageList.scrollTop)) return;
    messageList.scrollTo({ top: next, behavior: 'instant' });
  }

  /**
   * Rule 12: put the START of the column's last message at the top of the
   * viewport, for a column being opened to be read rather than followed.
   *
   * Declines when the message fits, because the end position already shows the
   * whole of it — the beginning included — and moving would only push the footer
   * out of view to no purpose. So this answers "was there anything to do", and a
   * caller that gets `false` should land where it otherwise would have.
   *
   * The move is the same relative, clamped delta elementIntoView uses (never
   * Element.scrollIntoView): rects are direction-agnostic, and in the reversed
   * scroller scrollTop increases toward the content end exactly as it does in a
   * normal column, so one offset serves both. Instant — this is where the column
   * opens, not a journey the reader takes.
   * @returns {boolean} True when the view was moved to the message's start.
   * @private
   */
  _lastMessageStartIntoView() {
    const messageList = this._list;
    const content = this._content;
    if (!messageList || !content) return false;

    // By tag rather than by DOM adjacency: the trailing children include the
    // footer and any non-message markers rendered after the last message.
    let last = null;
    for (const el of Array.from(content.children)) {
      if (MESSAGE_TAGS.has(/** @type {Element} */ (el).tagName)) last = el;
    }
    if (!last) return false;

    const listRect = messageList.getBoundingClientRect();
    const elRect = /** @type {Element} */ (last).getBoundingClientRect();
    if (elRect.height <= listRect.height) return false;

    messageList.scrollTo({
      top: messageList.scrollTop + (elRect.top - listRect.top),
      behavior: 'instant',
    });
    return true;
  }

  // ── Following the end (rules 8-11) ───────────────────────────────

  /**
   * Find the most relevant follow target when auto-following.
   *
   * Key principle: if there's content *after* a candidate, the user has
   * moved past it. Only follow a busy thread when it's the tail of the
   * conversation; otherwise follow the footer (or its spinner). This
   * keeps the auto-follow target glued to where new content is actually
   * appearing, not to a sub-thread tile that happens to still be running
   * higher up the list.
   *
   * Preference order:
   *   1. The currently-selected item, but only if it's a busy thread AND
   *      it sits at the tail of the list (otherwise the selection is an
   *      inspection target, not an "I'm watching this" target).
   *   2. The footer's processing spinner (if visible).
   *   3. A busy thread at the tail of the list.
   *   4. The footer itself.
   *   5. The last rendered element.
   * @returns {Element|null} Element to keep visible while auto-following
   * @private
   */
  _followTarget() {
    const messageList = this._list;
    if (!messageList) return null;

    const footer = messageList.querySelector('conversation-footer');
    const tailEl = footer?.previousElementSibling || messageList.lastElementChild;
    const tailIsBusyThread = tailEl?.tagName === 'THREAD-MESSAGE'
      && !tailEl.getAttribute('result');

    const selectedId = this._area.getSelectedItemId();
    if (selectedId) {
      const selected = messageList.querySelector(`[message-id="${selectedId}"]`);
      if (selected && selected === tailEl && tailIsBusyThread) return selected;
    }

    if (footer) {
      const processing = footer.querySelector('footer-processing');
      if (processing && !processing.classList.contains('hidden')) {
        return processing;
      }
    }

    if (tailIsBusyThread) return tailEl;

    if (footer) return footer;

    return messageList.lastElementChild;
  }

  /**
   * Rules 7–10: Keep the end of the conversation visible. Skips the work when the
   * view is already pinned to the very bottom of all content (avoids fighting the
   * user's scroll position or causing jank). Callers gate this on rule 11
   * themselves; the reader's own message goes through userSendIntoView, which
   * answers to no gate at all.
   */
  followIfNeeded() {
    const messageList = this._list;
    if (!messageList) return;
    if (!this._followTarget()) return;

    // "Already there?" — in the reversed scroller the very bottom of ALL
    // content (footer + any queued bubbles) sits at scrollTop 0, so the
    // distance from the bottom is just |scrollTop| (WebKit reports it negative
    // when scrolled up). No scrollHeight/clientHeight arithmetic needed.
    if (Math.abs(messageList.scrollTop) <= 1) return;

    // One consistent, layout-safe code-path: pin the very end of the content
    // (footer + queued items) above the composer, no matter how tall the
    // growable box currently is. Direct clamped scrollTop, never scrollIntoView.
    // Smooth-scroll: this is the deliberate auto-follow of the growing end of the
    // conversation, where a glide reads well. (Selection-driven and correction
    // scrolls call endIntoView() with no arg and stay instant.)
    this.endIntoView(true);
  }

  /**
   * Rule 8b: show the reader the message they just sent, from wherever in the
   * conversation they were. Sending is an explicit request to see what comes
   * back, so this move is unconditional — it consults neither rule 11's
   * near-bottom band nor the selection rules, and every other follow path defers
   * to it rather than the other way round.
   *
   * Instant, and it drops the reader's anchor, because the guarantee is that the
   * view IS at the end by the time the next item lands, not that it is on its way
   * there. Both of the things that could take it back read the live scroll
   * position: the anchor observer, and the near-bottom gate every arriving item
   * is tested against. A glide leaves that position reading "scrolled away" for
   * its whole duration — and over the distance this scroll can cover, in a
   * conversation long enough to get lost in, the answer's first tokens arrive
   * inside it. The instant, anchor-free move leaves nothing for them to fight.
   */
  userSendIntoView() {
    if (!this._list) return;
    this.releaseAnchor();
    this.endIntoView();
  }

  /**
   * Rule 4 + rule 11 together: is this column following the end of its
   * conversation, or is someone reading it?
   *
   * Two things say a reader has a place here, and either is enough. They are
   * scrolled away from the end (rule 11) — or a row they pinned is on screen
   * (rule 4), which says so without their having scrolled anywhere. The pin is
   * the half that was missing, and only a row pinned FROM the end can show it: a
   * row pinned part-way up a conversation is already protected by rule 11,
   * because reaching it meant scrolling there. A sub-thread tile is pinned from
   * the end by construction — it is the last row while the child runs, and
   * selecting one asks to read the child column (see rule A in
   * conversation-area-selection.js) — so it was the case with a pin and no
   * protection: every automatic move read "near the bottom" as "nobody is
   * reading", and the tile was carried off the top of the viewport by the
   * arriving turn, where rule C then retired a pin the reader still held.
   *
   * ON SCREEN is what makes the pin evidence, and the test cannot be dropped for
   * the simpler "is anything pinned". A reader who selects a row and then scrolls
   * back down to watch the end is following it again, whatever their stale
   * selection says; treating that as a place to keep hands the column to the
   * anchors, and each batch's growth is then undone as drift — which walks the
   * view backwards out of the near-bottom band one relayout at a time (rule 11's
   * own failure mode, guarded by unit:auto-follow-holds-the-end). A pinned row
   * that has left the viewport is the one rule C is about to retire anyway.
   *
   * Every automatic move in this component asks this rather than the bare
   * near-bottom test: the follow scrolls, and the reader anchors' prior question
   * of whether there is a place worth keeping.
   * @returns {boolean} True when the column may follow its own end.
   */
  isFollowingEnd() {
    if (this._area.selectionOrigin === 'user' && this._isPinnedRowOnScreen()) return false;
    return this.isNearBottom();
  }

  /**
   * Whether the column's selected row is currently within the message list's
   * viewport, even partly. Rect-derived rather than observed: this answers a
   * question asked DURING a mutation, and an IntersectionObserver's answer is
   * always at least a frame stale.
   * @returns {boolean} True when the selected row is at least partly visible.
   * @private
   */
  _isPinnedRowOnScreen() {
    const messageList = this._list;
    const selectedId = this._area.getSelectedItemId();
    if (!messageList || !selectedId) return false;
    const el = messageList.querySelector(`[message-id="${selectedId}"]`);
    if (!el) return false;
    const list = messageList.getBoundingClientRect();
    const row = el.getBoundingClientRect();
    return row.bottom > list.top && row.top < list.bottom;
  }

  /**
   * Check if user is currently scrolled near bottom
   * @returns {boolean} True if within 320px (~20rem) of bottom
   */
  isNearBottom() {
    const messageList = this._list;
    if (!messageList) return true;

    // Reversed scroller: distance from the bottom is |scrollTop| (0 at bottom).
    if (Math.abs(messageList.scrollTop) <= 320) return true;

    // Last message is at least partially visible (handles tall elements like long responses)
    const footer = messageList.querySelector('conversation-footer');
    const lastMessage = footer?.previousElementSibling;
    if (lastMessage) {
      return lastMessage.getBoundingClientRect().bottom < messageList.getBoundingClientRect().bottom;
    }

    return false;
  }

  /**
   * The topmost message element still touching the viewport (its bottom edge is
   * at or below the viewport top). Used as the anchor for element-based scroll
   * restore and for holding the reader's place while the tail bubble streams.
   * @returns {HTMLElement|null} Anchor element, or null if the list is empty.
   */
  topVisibleMessageElement() {
    const messageList = this._list;
    if (!messageList) return null;
    const content = this._content;
    if (!content) return null;
    const listTop = messageList.getBoundingClientRect().top;
    for (const el of Array.from(content.children)) {
      if (!MESSAGE_TAGS.has(el.tagName)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.bottom > listTop) {
        return /** @type {HTMLElement} */ (el);
      }
    }
    return null;
  }

  /**
   * Scroll to bottom if conditions allow
   * @param {boolean} [force=false] - If true, scroll regardless of user position
   */
  toBottom(force = false) {
    if (!this._list) return;

    // Don't auto-scroll if user has scrolled away, unless forced
    if (!force && !this.isNearBottom()) {
      return;
    }

    // A forced move is a deliberate one (a send, a reveal, a fresh load), so the
    // reader has no place left to keep — drop it, or the anchor observer measures
    // the move as drift and undoes it.
    if (force) this.releaseAnchor();

    // Cancel any pending scroll animation to prevent multiple queued scrolls
    if (this._frame !== null) {
      window.cancelAnimationFrame(this._frame);
    }

    // Queue a single scroll operation
    this._frame = window.requestAnimationFrame(() => {
      this.endIntoView();
      this._frame = null;
    });
  }

  // ── Persistence and landing (rule 12) ────────────────────────────

  /**
   * Persist current scroll state (atBottom + element anchor) to localStorage.
   * Called on pagehide; element-anchored so restore survives content height
   * changes that would invalidate an absolute scrollTop.
   */
  saveImmediately() {
    const conversation = this._area.conversation;
    if (!conversation) return;
    const top = this.topVisibleMessageElement();
    saveScrollState(conversation.id, {
      atBottom: this.isNearBottom(),
      topItemId: top ? top.getAttribute('message-id') : null,
    });
  }

  /**
   * The column is being pointed at a different thread context: a sub-thread it
   * owes a landing (rule 12), or the root (no landing). Owed EVERY time, because
   * columns are reused across thread navigations, so a flag spent once per
   * element would land the first thread opened here and never another. The
   * reader's place goes with the thread it was a place in — holding it would make
   * the incoming thread's landing stand down for a reader who is not there (see
   * restore).
   * @param {boolean} isThread - True for a sub-thread, false for the root.
   */
  pointAt(isThread) {
    this._landingPending = isThread;
    this.releaseAnchor();
  }

  /**
   * The column is showing a different conversation: its once-per-load restore is
   * owed again. The reader's place goes with it: it was a place in the
   * conversation this column is leaving, and holding it would make the incoming
   * conversation's restore stand down for a reader who is not there (see
   * restore).
   */
  forgetRestore() {
    this._restored = false;
    this.releaseAnchor();
  }

  /**
   * Where a column opens. Called by conversation-tab a frame after the messages
   * are rendered, so the rows this lands against have a layout to measure.
   *
   * Two jobs, in order of precedence. A column pointed at a sub-thread lands on
   * the start of that thread's last message (rule 12) — once per thread it is
   * shown, since columns are reused across thread navigations. Otherwise it
   * restores the position this conversation was left at, once per load.
   *
   * That frame is not owed to us promptly. A hidden, occluded or background window
   * can be a long way behind, so the restore can arrive after the reader has
   * already put the view somewhere of their own — and a held reader anchor is
   * exactly that signal (one is kept only while the reader sits away from the
   * end, and their scrolling is told apart from content drifting under them).
   * Landing on top of it would be an automatic jump away from where they just
   * went, which is the one move rule 11 exists to refuse. The move is spent
   * either way: it belongs to the open, and the open is over.
   *
   * Every branch moves the view immediately rather than through toBottom's
   * coalescing frame — this happens once, so there is nothing to coalesce, and a
   * second deferred jump is a second chance to land on top of the reader.
   */
  restore() {
    // A column pointed at a sub-thread owes that thread a landing, whatever this
    // element has already done for a thread it used to show (rule 12).
    const landing = this._landingPending;
    this._landingPending = false;
    if (this._restored && !landing) return;
    this._restored = true;

    const conversation = this._area.conversation;
    if (!conversation) return;
    if (this._anchor) return;

    // Rule 12. A thread still being driven falls through to the end, where its
    // next token lands; so does a last message short enough that the end position
    // already shows the start of it.
    if (landing && !this._area.getMessageThread()?.isProcessing
        && this._lastMessageStartIntoView()) return;

    const state = getScrollState(conversation.id);
    if (!state || state.atBottom) {
      this.endIntoView();
      return;
    }

    if (state.topItemId) {
      const anchor = this._list?.querySelector(`[message-id="${state.topItemId}"]`);
      if (anchor) {
        // Restoring to a mid-conversation anchor. scrollIntoView is
        // direction-agnostic — it computes the scrollport offset to land the
        // anchor at block-start regardless of the scroller's flex direction.
        // Instant: this is a one-shot restore on load, not a navigation glide,
        // so it must override the scroller's scroll-behavior: smooth.
        anchor.scrollIntoView({ block: 'start', behavior: 'instant' });
        return;
      }
    }
    this.endIntoView();
  }

  // ── Scroll controls ──────────────────────────────────────────────

  /**
   * Toggle each scroll-control button's visibility from the live scroll metrics.
   * In the reversed scroller the bottom (newest) is scrollTop 0 and the magnitude
   * grows toward the top, so |scrollTop| is the distance from the bottom and the
   * max magnitude is scrollHeight − clientHeight — both sign-agnostic.
   */
  updateControls() {
    const messageList = this._list;
    const controls = /** @type {HTMLElement|null} */ (this._area.querySelector('#scroll-controls'));
    if (!messageList || !controls) return;

    const topBtn = controls.querySelector('[data-scroll="top"]');
    const bottomBtn = controls.querySelector('[data-scroll="bottom"]');
    if (!topBtn || !bottomBtn) return;

    // Distance from the bottom (0) to the top, always >= 0.
    const range = messageList.scrollHeight - messageList.clientHeight;
    const fromBottom = Math.abs(messageList.scrollTop);

    if (range <= USEFUL_OVERFLOW_PX) {
      topBtn.classList.add('hidden');
      bottomBtn.classList.add('hidden');
      return;
    }

    // Hide the button for the end we're already resting near.
    topBtn.classList.toggle('hidden', fromBottom >= range - CONTROL_EDGE_PX);
    bottomBtn.classList.toggle('hidden', fromBottom <= CONTROL_EDGE_PX);
  }

  /**
   * Smooth-scroll to the very start (oldest message) of the conversation.
   *
   * Rects give the DIRECTION only, taken from the content column itself and never
   * its first child: the column leads with `thread-column-actions`, which is
   * `display: none` in a root conversation (it only appears in a thread column),
   * and a rect from a box-less element reads as all zeros — a delta of a few dozen
   * pixels of chrome, whatever the length of the conversation. The column's own
   * top is the top of the content by construction, whatever leads it.
   *
   * The DISTANCE is then the whole scrollable range rather than that measured
   * delta, because scrollTo clamps: overshooting lands exactly at the top, and a
   * trip that doesn't measure its own length can't be left short when rows change
   * height on the way (rendering as the glide brings them into range) after the
   * target was computed. Sign-agnostic, so the reversed scroller needs no special
   * case.
   */
  toConversationStart() {
    const messageList = this._list;
    const content = this._content;
    if (!messageList || !content) return;
    const delta = content.getBoundingClientRect().top - messageList.getBoundingClientRect().top;
    if (Math.abs(delta) < 1) return; // already at the start
    const range = messageList.scrollHeight - messageList.clientHeight;
    this.beginProgrammaticScroll();
    messageList.scrollTo({
      top: messageList.scrollTop + Math.sign(delta) * range,
      behavior: 'smooth'
    });
  }

  // ── Reader anchor ────────────────────────────────────────────────
  //
  // While the reader is scrolled away from the end, hold the lines under their
  // eyes still, whatever arrives below them.
  //
  // The scroller is column-reverse, which anchors the BOTTOM edge: anything
  // added at the end — an appended row, a streaming bubble growing, a tool row
  // that fills in its body a tick later, the footer changing height — shoves the
  // content above it up, and a reader who has scrolled up to read watches their
  // place walk off the top with nothing they can do about it while a turn runs.
  //
  // Nothing to do while near the end — there, being pinned to the bottom is the
  // point, native anchoring does it for free, and the streaming height glide
  // (conversation-area's _animateStreamingResize, which only runs while pinned)
  // smooths the rest.
  // ────────────────────────────────────────────────────────────────

  /**
   * Why an observer rather than a correction around each mutation: the content
   * does not settle when the mutation returns. Rendering a row can land in a
   * later task, so an anchor scoped to one DOM write holds only the part of the
   * growth that happened inside it. A ResizeObserver on the content column sees
   * every layout change however it arrives, and its callback runs in the
   * rendering steps BEFORE paint, so the correction is never a visible jump.
   * @private
   */
  _attachReaderAnchor() {
    const inner = this._content;
    if (!inner || typeof ResizeObserver === 'undefined') return;
    this.recordAnchor();
    const observer = new ResizeObserver(() => this.holdAnchor());
    observer.observe(inner);
    this._area.addCleanup(() => observer.disconnect());
  }

  /**
   * Record where the reader's place currently is, so a later layout change can
   * be measured against it. Called whenever the scroll position changes: after
   * the user scrolls, the top-visible row IS their new place.
   */
  recordAnchor() {
    if (this.isFollowingEnd()) {
      this._anchor = null;
      return;
    }
    const el = this.topVisibleMessageElement();
    this._anchor = el
      ? { el, top: el.getBoundingClientRect().top, contentHeight: this._content?.offsetHeight ?? 0 }
      : null;
  }

  /**
   * Let go of the reader's place: the view is being moved on purpose, so there
   * is no place left to keep. Without this the anchor observer would measure the
   * move as drift and undo it (holdAnchor). The next scroll or resize records
   * wherever the reader ends up.
   */
  releaseAnchor() {
    this._anchor = null;
  }

  /**
   * Run a DOM mutation with the reader's place held across it: measure a visible
   * row before, and afterwards nudge the scroll by however far that row moved.
   *
   * The observer is the general mechanism, but it can only correct what it is
   * told about, one frame later. This closes the mutation itself, where the bulk
   * of the movement happens and where the correction can land in the same task
   * the content changed in — measured, corrected, and never painted apart.
   * Rect-derived and relative, so it is sign-agnostic in the reversed scroller,
   * and instant: a glide here would be the very movement it prevents.
   * @param {() => void} mutate - The DOM mutation to run.
   * @param {{skip?: boolean}} [opts] - `skip`: the caller is following the end of
   *   the conversation, where native bottom-anchoring is what's wanted and there
   *   is no reader's place to keep.
   */
  holdAnchorOver(mutate, { skip = false } = {}) {
    const scroller = this._list;
    const el = (skip || !scroller) ? null : this.topVisibleMessageElement();
    const before = el ? el.getBoundingClientRect().top : 0;

    mutate();

    // A row the mutation removed is no anchor; the observer picks the reader's
    // place up again from the next scroll or resize.
    if (!el || !scroller || !el.isConnected) return;
    const shift = el.getBoundingClientRect().top - before;
    if (Math.abs(shift) <= 0.5) return;
    scroller.scrollTo({ top: scroller.scrollTop + shift, behavior: 'instant' });
    this.recordAnchor();
  }

  /**
   * Record the reader's place from a scroll event — unless the content is what
   * moved, in which case this scroll is the drift we exist to undo.
   *
   * A scroll event is not evidence that the reader scrolled. Growing the content
   * of this bottom-anchored scroller moves the scroll offset by itself, and the
   * browser fires the scroll steps BEFORE it delivers resize observations: take
   * that event at face value and the anchor is re-recorded at the drifted
   * position, so the correction that follows measures a shift of zero and the
   * reader is left where the content put them. Content size is what tells the
   * two apart — the reader moving the view doesn't change it.
   * @private
   */
  _recordAnchorFromScroll() {
    const inner = this._content;
    if (this._anchor && inner && inner.offsetHeight !== this._anchor.contentHeight) return;
    this.recordAnchor();
  }

  /**
   * Put the anchored row back where it was, by nudging the scroll position by
   * however far it drifted. Relative and rect-derived, so it is sign-agnostic
   * across the reversed scroller, and instant — a glide here would be the very
   * movement it exists to prevent.
   */
  holdAnchor() {
    // A scroll this column asked for is not drift, however much the content
    // resizes under it; leave it alone until it lands (beginProgrammaticScroll).
    if (this._programmatic) return;
    const anchor = this._anchor;
    if (!anchor) return;
    // An anchor whose row the rebuild removed can't be measured; take the new
    // top-visible row as the place instead, from this position on.
    if (!anchor.el.isConnected || this.isFollowingEnd()) {
      this.recordAnchor();
      return;
    }
    const scroller = this._list;
    if (!scroller) return;
    const shift = anchor.el.getBoundingClientRect().top - anchor.top;
    if (Math.abs(shift) <= 0.5) return;
    scroller.scrollTo({ top: scroller.scrollTop + shift, behavior: 'instant' });
    // Re-measure rather than assume the nudge landed in full: scrollTop clamps
    // at both ends of the range, and a clamped correction is the true new place.
    anchor.top = anchor.el.getBoundingClientRect().top;
    anchor.contentHeight = this._content?.offsetHeight ?? 0;
  }

  /**
   * Declare that the scroll about to be issued is one this column asked for, so
   * the reader anchor leaves it alone until it lands.
   *
   * The anchor undoes movement the reader did not ask for, and its cue is "the
   * content changed size" (_recordAnchorFromScroll). A long glide is
   * indistinguishable by that test: rows render as it brings them into range and
   * the content genuinely does change size, so the anchor keeps the place from
   * before the click, measures the whole journey as drift, and scrolls back to
   * cancel it — which also cancels the glide, because a scrollTo interrupts one
   * in flight. The trip dies part-way and the next click starts over from wherever
   * it stopped. A turn streaming underneath does the same with no row-skipping
   * involved at all. So a scroll we issued is marked as ours while it travels.
   */
  beginProgrammaticScroll() {
    this._programmatic = true;
    this._armSettle();
  }

  /**
   * (Re)arm the timer that ends the programmatic-scroll window. Every scroll event
   * the glide emits pushes it out, so it fires only once the view has been still
   * for PROGRAMMATIC_SCROLL_SETTLE_MS — at which point where the scroll landed IS
   * the reader's new place, and the anchor is recorded there.
   * @private
   */
  _armSettle() {
    if (this._settleTimer !== null) clearTimeout(this._settleTimer);
    this._settleTimer = window.setTimeout(() => {
      this._settleTimer = null;
      this._programmatic = false;
      this.recordAnchor();
    }, PROGRAMMATIC_SCROLL_SETTLE_MS);
  }
}
