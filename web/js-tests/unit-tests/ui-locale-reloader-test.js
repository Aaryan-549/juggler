//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * A viewer window following a UI language chosen in another window: it waits
 * until it is idle — no turn running, no modal or menu open, no keystrokes yet
 * to be saved — then reloads itself, once.
 *
 * Everything the reloader asks the page is a stub here: the page's language,
 * the three idle probes, the reload, and the re-check timer, which the test
 * fires by hand. Nothing touches the shared test server's UI language.
 * @module unit-tests/ui-locale-reloader-test
 */

import { assert } from '../utilities/test-helpers.js';
import { createUILocaleReloader, reportUILocale } from '../../js/services/ui-locale.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed The count of assertions that succeeded.
 * @property {number} failed The count of assertions that threw.
 * @property {string[]} errors The collected failure messages.
 */

/**
 * A reloader over stubbed probes, with a timer the test fires itself.
 * @param {{page?: string, choosing?: boolean}} [opts]
 * @returns {{
 *   reloader: ReturnType<typeof createUILocaleReloader>,
 *   probes: {busy: boolean, modal: boolean, draft: boolean, choosing: boolean},
 *   reloads: () => number,
 *   timers: () => number,
 *   tick: () => void,
 * }} The reloader and its controls.
 */
function setup({ page = '', choosing = false } = {}) {
  const probes = { busy: false, modal: false, draft: false, choosing };
  let reloads = 0;
  /** @type {Map<number, () => void>} */
  const pending = new Map();
  let nextId = 1;
  const reloader = createUILocaleReloader({
    pageLocale: () => page,
    isBusy: () => probes.busy,
    isModalOpen: () => probes.modal,
    hasUnsavedDraft: () => probes.draft,
    isChoosing: () => probes.choosing,
    reload: () => { reloads++; },
    setTimer: (fn) => {
      const id = nextId++;
      pending.set(id, fn);
      return id;
    },
    clearTimer: (id) => { pending.delete(/** @type {number} */ (id)); },
  });
  return {
    reloader,
    probes,
    reloads: () => reloads,
    timers: () => pending.size,
    tick: () => {
      const due = [...pending.values()];
      pending.clear();
      for (const fn of due) fn();
    },
  };
}

/**
 * @param {object} _ctx
 * @returns {Promise<TestResult>} Resolves with the aggregated test result.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label
   * @param {() => void} fn
   */
  const run = (label, fn) => {
    try {
      fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  run('the language the page is already in does nothing', () => {
    const s = setup({ page: 'en-XA' });
    s.reloader.update('en-XA');
    assert(s.reloads() === 0, `reloads: ${s.reloads()}`);
    assert(!s.reloader.pending(), 'nothing is pending');
    assert(s.timers() === 0, `timers armed: ${s.timers()}`);
  });

  run('an idle window reloads at once', () => {
    const s = setup();
    s.reloader.update('en-XA');
    assert(s.reloads() === 1, `reloads: ${s.reloads()}`);
  });

  run('a busy window waits, then reloads exactly once when idle', () => {
    const s = setup();
    s.probes.busy = true;
    s.reloader.update('en-XA');
    assert(s.reloads() === 0, `reloaded while a turn was running: ${s.reloads()}`);
    assert(s.reloader.pending(), 'the reload is pending');
    s.tick();
    s.tick();
    assert(s.reloads() === 0, `reloaded while still busy: ${s.reloads()}`);
    s.probes.busy = false;
    s.tick();
    assert(s.reloads() === 1, `reloads once idle: ${s.reloads()}`);
    assert(s.timers() === 0, `a timer outlived the reload: ${s.timers()}`);
    s.reloader.update('en-XA');
    s.tick();
    assert(s.reloads() === 1, `reloaded twice: ${s.reloads()}`);
  });

  run('an open modal and an unsaved draft each hold the reload', () => {
    const s = setup();
    s.probes.modal = true;
    s.reloader.update('en-XA');
    s.tick();
    assert(s.reloads() === 0, `reloaded over an open modal: ${s.reloads()}`);
    s.probes.modal = false;
    s.probes.draft = true;
    s.tick();
    assert(s.reloads() === 0, `reloaded over unsaved typing: ${s.reloads()}`);
    s.probes.draft = false;
    s.tick();
    assert(s.reloads() === 1, `reloads: ${s.reloads()}`);
  });

  run('a second change while waiting schedules no second reload', () => {
    const s = setup();
    s.probes.busy = true;
    s.reloader.update('en-XA');
    s.reloader.update('en');
    s.reloader.update('en-XA');
    assert(s.timers() === 1, `timers armed: ${s.timers()}`);
    s.probes.busy = false;
    s.tick();
    assert(s.reloads() === 1, `reloads: ${s.reloads()}`);
  });

  run('changing back to the page language cancels the wait', () => {
    const s = setup();
    s.probes.busy = true;
    s.reloader.update('en-XA');
    s.reloader.update('');
    assert(!s.reloader.pending(), 'still pending after the change back');
    assert(s.timers() === 0, `timers armed: ${s.timers()}`);
    s.probes.busy = false;
    s.tick();
    assert(s.reloads() === 0, `reloads: ${s.reloads()}`);
  });

  run('the window that chose the language leaves the reload to the choice', () => {
    const s = setup({ choosing: true });
    s.reloader.update('en-XA');
    assert(s.reloads() === 0, `reloads: ${s.reloads()}`);
    assert(!s.reloader.pending(), 'pending');

    const t = setup();
    t.probes.busy = true;
    t.reloader.update('en-XA');
    t.probes.choosing = true;
    t.probes.busy = false;
    t.tick();
    assert(t.reloads() === 0, `a waiting reload fired after this window chose: ${t.reloads()}`);
    assert(!t.reloader.pending(), 'still pending after this window chose');
  });

  run('dispose stops the wait', () => {
    const s = setup();
    s.probes.busy = true;
    s.reloader.update('en-XA');
    s.reloader.dispose();
    assert(s.timers() === 0, `timers armed: ${s.timers()}`);
    s.probes.busy = false;
    s.tick();
    assert(s.reloads() === 0, `reloads: ${s.reloads()}`);
  });

  run('a desktop window tells its host the language it was served in', () => {
    /** @type {Array<[string, string]>} */
    const posts = [];
    const post = (/** @type {string} */ endpoint, /** @type {string} */ query) => { posts.push([endpoint, query]); };
    reportUILocale('en-XA', post, () => true);
    // The default language has no tag on the page; the host hears English.
    reportUILocale('', post, () => true);
    // A browser tab has no host to tell.
    reportUILocale('fr', post, () => false);
    assert(JSON.stringify(posts) === JSON.stringify([['locale', '?locale=en-XA'], ['locale', '?locale=en']]),
      `posts: ${JSON.stringify(posts)}`);
  });

  return { passed, failed, errors };
}
