//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Registries-ready gate — an awaitable signal that the capability registries
 * have completed their initial hydration at least once.
 *
 * All of them, whichever they are: this gate is one latch flipped by
 * `initAllRegistries`, and it has never named them individually in code. The
 * list it used to name here had drifted to twice its length.
 *
 * System-prompt assembly gates extension contributions on the set of enabled
 * plugin ids, which is only knowable once the registries have loaded. Awaiting
 * this signal before reading the registries guarantees the prompt is rendered
 * against a fully-hydrated set, so a turn that assembles the prompt during the
 * post-resume hydration window produces the same bytes as a steady-state turn.
 *
 * This module deliberately has NO imports: it sits below both the registries
 * layer (which marks it ready) and the services layer (which awaits it), so a
 * static import here would create a cycle.
 * @module registries/registry-ready
 */

/** @type {() => void} */
let resolveReady;

/** @type {Promise<void>} */
const readyPromise = new Promise((resolve) => {
  resolveReady = resolve;
});

/**
 * Mark the registries as hydrated, resolving the readiness promise. Idempotent:
 * the first call resolves the promise and every later call is a no-op. The
 * signal stays resolved across registry reloads; the window in which a reload
 * has emptied the registries is {@link whenRegistriesRebuilt}'s to report.
 */
export function markRegistriesReady() {
  resolveReady();
}

/**
 * @returns {Promise<void>} Resolves once the registries have hydrated at least once
 */
export function whenRegistriesReady() {
  return readyPromise;
}

/** @type {Promise<void>|null} */
let rebuildWindow = null;

/**
 * Open the rebuild window: the registries are about to be reset and stay empty
 * or partial until the returned function is called, after re-init. Rebuilds are
 * serialised by reloadRegistries, so windows never overlap.
 * @returns {() => void} Closes the window
 */
export function beginRegistryRebuild() {
  /** @type {() => void} */
  let close = () => {};
  const opened = new Promise((resolve) => { close = () => resolve(undefined); });
  rebuildWindow = opened;
  return () => {
    if (rebuildWindow === opened) rebuildWindow = null;
    close();
  };
}

/**
 * Wait out a registry rebuild that has reset the registries and not yet
 * re-initialised them, so a turn's tool list or system prompt is never built
 * from a partial set. Resolves at once when no rebuild is in that window —
 * including while a reload is still waiting for local turns to finish, when the
 * registries are intact. That distinction is the point: the requesting turn is
 * one of the turns such a reload waits for, so waiting for the whole reload
 * would wait on itself.
 * @returns {Promise<void>} Resolves once no rebuild has the registries reset
 */
export function whenRegistriesRebuilt() {
  return rebuildWindow || Promise.resolve();
}
