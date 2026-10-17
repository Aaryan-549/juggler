//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The session's event feed: one synchronous fan-out that the session, its
 * extracts (the sync reducer, the persistence) and every Conversation announce
 * on, and that components subscribe to.
 *
 * The names are a closed set, {@link SessionEventType}. Both doors are typed
 * with it, so an announcement under a name nobody listens for, or a listener
 * testing for a name nobody sends, is a type error rather than a check that
 * quietly never matches.
 *
 * Each listener is contained, as on the socket's emitter: its throw goes to
 * the fault sink and the fan-out carries on, because subscribers are
 * independent and a release viewer has no console to read the throw in.
 * @module model/session-events
 */

import { reportFault } from '../utils/fault-report.js';

/** @typedef {import('./session.js').default} Session */

/**
 * Every name announced on the session feed.
 *
 * Session-level: `session:loaded` (a load or a project switch adopted a
 * manifest), `session:saved`, `session:save-error`, `session:metadata-changed`
 * (`data.keys` names what moved), `session:workspaces-changed`,
 * `workspace:selected`.
 *
 * The conversation list: `conversation:created`, `conversation:deleted`,
 * `conversation:renamed`, `conversation:rename-requested`,
 * `conversation:reordered`, `conversation:switched`,
 * `conversation:focus-followed`, `conversation:auto-naming`.
 *
 * One conversation, announced by the Conversation itself:
 * `conversation:changed`, `conversation:loadstate-changed`,
 * `conversation:items-removed`, `conversation:context-window-updated`,
 * `conversation:strategy-changed`, `context-items:changed`,
 * `processing:stopped`.
 *
 * A model asking for a view, which the model may not reach itself:
 * `conversation:turn-requested`, `command-manager:open-requested`,
 * `conversation-export:open-requested`, `conversation:thread-open-requested`,
 * `conversation:warning-requested`, and the three a conversation's tab answers
 * in its composer: `composer:clear-requested`, `composer:restore-requested`,
 * `composer:draft-requested`. A warning request is the one that carries an
 * answer back: the tab sets `heard` and `shown` on it, so the conversation can
 * record a warning nobody showed (see `Conversation.showWarning`).
 * @typedef {'session:loaded'|'session:saved'|'session:save-error'|'session:metadata-changed'
 *   |'session:workspaces-changed'|'workspace:selected'
 *   |'conversation:created'|'conversation:deleted'|'conversation:renamed'|'conversation:rename-requested'
 *   |'conversation:reordered'|'conversation:switched'|'conversation:focus-followed'|'conversation:auto-naming'
 *   |'conversation:changed'|'conversation:loadstate-changed'|'conversation:items-removed'
 *   |'conversation:context-window-updated'|'conversation:strategy-changed'|'context-items:changed'
 *   |'processing:stopped'
 *   |'conversation:turn-requested'|'command-manager:open-requested'|'conversation-export:open-requested'
 *   |'conversation:thread-open-requested'|'conversation:warning-requested'
 *   |'composer:clear-requested'|'composer:restore-requested'|'composer:draft-requested'
 * } SessionEventType
 */

/**
 * One announcement, as a listener receives it.
 * @typedef {object} SessionEvent
 * @property {SessionEventType} type - What happened
 * @property {any} data - What it happened to; the shape belongs to the name
 * @property {Session} session - The session it happened on
 */

/** @typedef {(event: SessionEvent) => void} SessionEventListener */

class SessionEvents {
  /**
   * @param {Session} session - The session each event is stamped with.
   */
  constructor(session) {
    /** @type {Session} @private */
    this._session = session;

    /**
     * The subscriptions, in the order they were taken. Each is its own entry,
     * so one callback subscribed twice is called twice, and either
     * unsubscribe releases only its own.
     * @type {Set<{callback: SessionEventListener}>}
     * @private
     */
    this._listeners = new Set();
  }

  /**
   * Listen to every announcement on the feed.
   * @param {SessionEventListener} callback - Called synchronously with each event.
   * @returns {() => void} Stops this subscription; calling it again does nothing.
   */
  subscribe(callback) {
    const entry = { callback };
    this._listeners.add(entry);
    return () => { this._listeners.delete(entry); };
  }

  /**
   * Announce an event to every listener, synchronously and in subscription
   * order. The walk is over the live set: a listener subscribed during the
   * fan-out hears this event too, and one unsubscribed before it is reached
   * does not.
   * @param {SessionEventType} type - What happened
   * @param {any} data - What it happened to
   */
  notify(type, data) {
    for (const entry of this._listeners) {
      try {
        entry.callback({ type, data, session: this._session });
      } catch (error) {
        reportFault(`session-listener:${type}`, error);
      }
    }
  }

  /** Drop every subscription; the session's destroy calls it. */
  clear() {
    this._listeners.clear();
  }
}

export default SessionEvents;
