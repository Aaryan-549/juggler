//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The machine server's sessions page: the sessions this machine runs, and a
 * way to open, stop, retry or dismiss each, plus launching a new one from the
 * machine's recent projects or a typed path.
 *
 * Everything it does goes through the control API it is given, and every
 * window it opens through the `openWindow` it is given, so it runs as well
 * against stand-ins as against the server.
 *
 * A session opens in a tab named for it ({@link sessionWindowName}), so opening
 * it again from here finds the tab it is already in. A session launched from
 * here gets its tab inside the click — before the server has answered, so no
 * popup blocker refuses it — and the tab is sent to the session once it runs.
 * @module machine/sessions-view
 */

import { t, formatRelativeTime } from '../sdk/lib/i18n.js';
import { OPEN_IN_NEW_SVG } from '../js/utils/icons.js';
import { extractErrorMessage } from '../sdk/lib/error-utils.js';
import { ControlApiError } from './control-api.js';

/** How many recent projects the page offers. */
const RECENTS_SHOWN = 8;

/**
 * @typedef {import('./control-api.js').Session} Session
 * @typedef {import('./control-api.js').PageConfig} PageConfig
 * @typedef {{
 *   listSessions: () => Promise<Session[]>,
 *   openSession: (project: string) => Promise<Session>,
 *   stopSession: (id: string) => Promise<void>,
 *   recents: () => Promise<string[]>,
 * }} ControlApi
 * @typedef {{
 *   name: string,
 *   closed?: boolean,
 *   location: { href: string },
 *   document?: { title: string, body: { textContent: string } | null },
 *   close: () => void,
 * }} OpenedWindow
 */

/**
 * The name of the tab a session opens in.
 * @param {string} id - The session's ID.
 * @returns {string} A window name unique to the session.
 */
export function sessionWindowName(id) {
  return `juggler-session-${id}`;
}

/**
 * The URL a session is served under on this server.
 * @param {string} id - The session's ID.
 * @returns {string} Its path, /s/<id>/.
 */
function sessionUrl(id) {
  return `/s/${encodeURIComponent(id)}/`;
}

/**
 * The last segment of a path, for a project's display name.
 * @param {string} p - A folder path, POSIX or Windows.
 * @returns {string} Its last segment (the path itself if it has none).
 */
function baseName(p) {
  return p.split(/[\\/]+/).filter(Boolean).at(-1) ?? p;
}

/**
 * A distance in time, in the largest unit that keeps it whole enough to read.
 * @param {number} ms - Signed milliseconds from now (negative is past).
 * @returns {string} "5 minutes ago", "in 4 seconds", ….
 */
function relative(ms) {
  const s = Math.round(ms / 1000);
  const abs = Math.abs(s);
  if (abs < 60) return formatRelativeTime(s, 'second');
  if (abs < 3600) return formatRelativeTime(Math.round(s / 60), 'minute');
  if (abs < 86400) return formatRelativeTime(Math.round(s / 3600), 'hour');
  return formatRelativeTime(Math.round(s / 86400), 'day');
}

/**
 * What a session is doing, as the page shows it: a running session is busy or
 * idle; any other state is its own.
 * @param {Session} s - The session.
 * @returns {string} busy, idle, starting, stopping, restarting or error.
 */
function displayState(s) {
  if (s.state === 'running') return s.busy ? 'busy' : 'idle';
  return s.state;
}

/**
 * The line under a session's name saying what it is doing.
 * @param {Session} s - The session.
 * @param {number} now - The time now, in ms.
 * @returns {string} Its status line.
 */
function statusText(s, now) {
  switch (displayState(s)) {
    case 'busy':
      return t('Working');
    case 'idle':
      return s.lastActive
        ? t('Idle · last active {when}', { when: relative(Date.parse(s.lastActive) - now) })
        : t('Idle');
    case 'starting':
      return t('Starting…');
    case 'stopping':
      return t('Stopping…');
    case 'restarting': {
      const when = s.nextRestartAt ? relative(Math.max(0, Date.parse(s.nextRestartAt) - now)) : '';
      const retry = when ? t('Crashed · restarting {when}', { when }) : t('Crashed · restarting');
      if (!s.restarts) return retry;
      return `${retry} · ${t('{count, plural, one {restarted # time} other {restarted # times}}', { count: s.restarts })}`;
    }
    case 'error':
      return s.error ? t('Stopped: {reason}', { reason: s.error }) : t('Stopped');
    default:
      return s.state;
  }
}

/**
 * Build an element.
 * @param {string} tag - Tag name.
 * @param {{className?: string, text?: string, attrs?: Record<string, string>}} [props] - Class, text and attributes.
 * @param {Array<Node|null|false>} [children] - Children, skipping falsy ones.
 * @returns {HTMLElement} The element.
 */
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = props.text;
  for (const [k, v] of Object.entries(props.attrs || {})) node.setAttribute(k, v);
  for (const c of children) if (c) node.appendChild(c);
  return node;
}

/**
 * An icon from the app's set, as a decorative element.
 * @param {string} svg - Its SVG markup (a constant from icons.js).
 * @returns {HTMLElement} A span holding it.
 */
function icon(svg) {
  const span = el('span', { className: 'ms-icon', attrs: { 'aria-hidden': 'true' } });
  span.innerHTML = svg;
  return span;
}

/**
 * Mount the sessions page into root and load it.
 * @param {HTMLElement} root - Where the page goes.
 * @param {object} options
 * @param {ControlApi} options.api - The control API.
 * @param {PageConfig} options.config - What the server handed the page.
 * @param {(url: string, name: string) => OpenedWindow|null} [options.openWindow] - Opens a tab.
 * @param {(message: string) => boolean} [options.confirm] - Asks the user a yes/no question.
 * @param {() => number} [options.now] - The time now, in ms.
 * @param {number} [options.pollMs] - How often to refresh the list (0: never by itself).
 * @returns {{refresh: () => Promise<void>, dispose: () => void}} The page: refresh it now, or take it down.
 */
export function mountSessionsPage(root, {
  api,
  config,
  openWindow = (url, name) => /** @type {OpenedWindow|null} */ (/** @type {unknown} */ (window.open(url, name))),
  confirm = (message) => window.confirm(message),
  now = () => Date.now(),
  pollMs = 2000,
}) {
  /** @type {Session[]} */
  let sessions = [];
  /** @type {string[]} */
  let recents = [];
  /** @type {ControlApiError|null} */
  let unreachable = null;
  /** IDs with a stop or dismiss in flight, whose actions are held. */
  const pending = new Set();
  let disposed = false;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let timer = null;

  root.replaceChildren();
  const logo = el('img', {
    className: 'ms-logo',
    attrs: { src: new URL('../resources/juggler-logo.svg', import.meta.url).pathname, alt: '' },
  });
  const header = el('header', { className: 'ms-header' }, [
    logo,
    el('div', { className: 'ms-title' }, [
      el('h1', { text: t('Sessions') }),
      el('p', { className: 'ms-subtitle', text: config.host ? t('Juggler on {host}', { host: config.host }) : t('Juggler on this machine') }),
    ]),
    config.version ? el('span', { className: 'ms-version', text: config.version }) : null,
  ]);
  const banner = el('div', { className: 'ms-banner-slot', attrs: { role: 'status' } });

  const input = /** @type {HTMLInputElement} */ (el('input', {
    className: 'ms-launch-input',
    attrs: {
      type: 'text',
      name: 'project',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: t('/path/to/project or ~/project'),
      'aria-label': t('Project folder'),
    },
  }));
  const launchButton = el('button', { className: 'ms-button ms-button-primary', text: t('Open'), attrs: { type: 'submit' } });
  const launchError = el('p', { className: 'ms-launch-error', attrs: { role: 'alert' } });
  const form = /** @type {HTMLFormElement} */ (el('form', { className: 'ms-launch' }, [input, launchButton]));
  const recentsList = el('ul', { className: 'ms-recents', attrs: { 'aria-label': t('Recent projects') } });
  const launchSection = el('section', { className: 'ms-section' }, [
    el('h2', { text: t('Open a project') }),
    form,
    launchError,
    recentsList,
  ]);

  const count = el('span', { className: 'ms-sessions-count' });
  const sessionsList = el('ul', { className: 'ms-sessions' });
  const sessionsSection = el('section', { className: 'ms-section' }, [
    el('h2', {}, [document.createTextNode(t('Running')), count]),
    sessionsList,
  ]);

  root.append(header, banner, sessionsSection, launchSection);

  /**
   * Show why a launch failed, or clear it.
   * @param {string} message - The reason ('' clears it).
   */
  function showLaunchError(message) {
    launchError.textContent = message;
    launchError.hidden = !message;
  }
  showLaunchError('');

  /**
   * Launch (or find) the session for project and take the user to it.
   * @param {string} project - The folder, as given.
   * @returns {Promise<boolean>} Whether it opened.
   */
  async function launch(project) {
    showLaunchError('');
    // The tab is opened now, inside the user's click, and filled in later.
    const win = openWindow('', '');
    if (win?.document?.body) {
      try {
        win.document.title = t('Starting…');
        win.document.body.textContent = t('Starting a session for {project}…', { project });
      } catch {
        // A tab the browser would not let us write to still gets its URL below.
      }
    }
    try {
      const sess = await api.openSession(project);
      if (win && !win.closed) {
        win.location.href = sessionUrl(sess.id);
        win.name = sessionWindowName(sess.id);
      }
      await refresh();
      return true;
    } catch (err) {
      win?.close();
      showLaunchError(err instanceof Error ? err.message : t('The session could not be started.'));
      return false;
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const project = input.value.trim();
    if (!project) {
      input.focus();
      return;
    }
    if (await launch(project)) input.value = '';
  });

  /**
   * Stop (or dismiss) a session, asking first when a turn is running in it.
   * @param {Session} s - The session.
   * @param {boolean} ask - Whether a running turn needs a yes first.
   */
  async function stop(s, ask) {
    if (ask && s.busy && !confirm(t('A turn is running in {name}. Stop the session anyway?', { name: baseName(s.project) }))) {
      return;
    }
    pending.add(s.id);
    render();
    try {
      await api.stopSession(s.id);
    } catch (err) {
      showLaunchError(err instanceof Error ? err.message : t('The session could not be stopped.'));
    } finally {
      pending.delete(s.id);
    }
    await refresh();
  }

  /**
   * A link that opens a session in its tab.
   * @param {Session} s - The session.
   * @param {string} className - The link's class.
   * @returns {HTMLElement} The link.
   */
  function openLink(s, className) {
    const a = el('a', {
      className: `ms-button ms-button-primary ${className}`,
      attrs: { href: sessionUrl(s.id), target: sessionWindowName(s.id), rel: 'opener' },
    }, [icon(OPEN_IN_NEW_SVG), el('span', { text: t('Open') })]);
    return a;
  }

  /**
   * A button that runs onClick.
   * @param {string} label - Its text.
   * @param {string} className - Its classes.
   * @param {() => void} onClick - What it does.
   * @param {boolean} [disabled] - Whether it is held.
   * @returns {HTMLButtonElement} The button.
   */
  function button(label, className, onClick, disabled = false) {
    const b = /** @type {HTMLButtonElement} */ (el('button', { className: `ms-button ${className}`, text: label, attrs: { type: 'button' } }));
    b.disabled = disabled;
    b.addEventListener('click', onClick);
    return b;
  }

  /**
   * One session's row.
   * @param {Session} s - The session.
   * @returns {HTMLElement} Its list item.
   */
  function sessionRow(s) {
    const state = displayState(s);
    const held = pending.has(s.id);
    /** @type {Array<HTMLElement>} */
    const actions = [];
    if (state === 'busy' || state === 'idle') {
      actions.push(openLink(s, 'ms-session-open'));
      actions.push(button(t('Stop'), 'ms-button-quiet ms-session-stop', () => { void stop(s, true); }, held));
    } else if (state === 'restarting') {
      actions.push(button(t('Stop'), 'ms-button-quiet ms-session-stop', () => { void stop(s, false); }, held));
    } else if (state === 'error') {
      actions.push(button(t('Retry'), 'ms-button-primary ms-session-retry', () => { void launch(s.project); }, held));
      actions.push(button(t('Dismiss'), 'ms-button-quiet ms-session-dismiss', () => { void stop(s, false); }, held));
    }
    const item = el('li', { className: 'ms-session', attrs: { 'data-session-id': s.id, 'data-state': state } }, [
      el('span', { className: 'ms-dot', attrs: { 'aria-hidden': 'true' } }),
      el('div', { className: 'ms-session-main' }, [
        el('div', { className: 'ms-session-name', text: baseName(s.project) }),
        el('div', { className: 'ms-path', text: s.project }),
        el('div', { className: 'ms-session-status', text: statusText(s, now()) }),
      ]),
      el('div', { className: 'ms-actions' }, actions),
    ]);
    return item;
  }

  /**
   * One recent project's row: a way to its running session, or to start one.
   * @param {string} project - The folder.
   * @returns {HTMLElement} Its list item.
   */
  function recentRow(project) {
    const running = sessions.find((s) => s.project === project && s.state !== 'error');
    const action = running
      ? el('a', {
        className: 'ms-button ms-button-quiet ms-recent-session',
        text: t('Running'),
        attrs: { href: sessionUrl(running.id), target: sessionWindowName(running.id), rel: 'opener' },
      })
      : button(t('Open'), 'ms-button-quiet ms-recent-open', () => { void launch(project); });
    return el('li', { className: 'ms-recent', attrs: { 'data-project': project } }, [
      el('div', { className: 'ms-recent-main' }, [
        el('div', { className: 'ms-recent-name', text: baseName(project) }),
        el('div', { className: 'ms-path', text: project }),
      ]),
      action,
    ]);
  }

  /** Redraw the lists and notices from the last answers. */
  function render() {
    if (unreachable) {
      const outOfDate = unreachable.status === 401;
      banner.replaceChildren(el('div', { className: 'ms-unreachable' }, [
        el('span', {
          text: outOfDate
            ? t('This page belongs to a Juggler server that has since restarted. Reload it to continue.')
            : t('Can’t reach Juggler on this machine. Trying again…'),
        }),
        outOfDate ? button(t('Reload'), 'ms-button-quiet', () => window.location.reload()) : null,
      ]));
    } else {
      banner.replaceChildren();
    }

    count.textContent = sessions.length ? ` ${sessions.length}` : '';
    count.setAttribute('aria-label', t('{count, plural, one {# session} other {# sessions}}', { count: sessions.length }));
    if (sessions.length) {
      sessionsList.replaceChildren(...sessions.map(sessionRow));
    } else {
      sessionsList.replaceChildren(el('li', {
        className: 'ms-sessions-empty',
        text: t('No sessions are running. Open a project below to start one.'),
      }));
    }

    recentsList.replaceChildren(...recents.slice(0, RECENTS_SHOWN).map(recentRow));
    recentsList.hidden = recents.length === 0;
  }

  /**
   * Ask the server for the sessions and recent projects, and redraw.
   * @returns {Promise<void>} Resolves once redrawn.
   */
  async function refresh() {
    try {
      const [list, paths] = await Promise.all([api.listSessions(), api.recents()]);
      sessions = list || [];
      recents = paths || [];
      unreachable = null;
    } catch (err) {
      unreachable = err instanceof ControlApiError ? err : new ControlApiError(0, extractErrorMessage(err));
    }
    if (!disposed) render();
  }

  /** Refresh, then again after pollMs, while the page is shown. */
  function schedule() {
    if (disposed || !pollMs) return;
    timer = setTimeout(async () => {
      timer = null;
      if (!document.hidden) await refresh();
      schedule();
    }, pollMs);
  }

  const onVisible = () => {
    if (!document.hidden) void refresh();
  };
  document.addEventListener('visibilitychange', onVisible);
  render();
  schedule();

  return {
    refresh,
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    },
  };
}
