//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The workspace dialogs — the move confirmation
 * (`components/workspace-move-dialog.js`), the reconnect question
 * (`components/workspace-reconnect-dialog.js`) and the finish dialog
 * (`components/workspace-finish-dialog.js`) — a workspace box's header
 * (`components/workspace-box-header.js`), and the place list and setup form the
 * dialogs share (`services/workspace-places.js`,
 * `components/workspace-setup-form.js`) follow the UI language in every state
 * they draw.
 *
 * Both run against stand-in sessions and conversations, so nothing is moved:
 * the one move pressed is refused by a throw, and the reconnect's register
 * call is answered by a fetch stub. The workspace provider registry holds only
 * a stand-in provider for the duration, and is put back afterwards; the place
 * list's offer table likewise, since a sibling suite in the lane fills it.
 * @module unit-tests/workspace-dialogs-test
 */

import { openWorkspaceMove } from '../../js/components/workspace-move-dialog.js';
import { openWorkspaceReconnect } from '../../js/components/workspace-reconnect-dialog.js';
import { openWorkspaceFinish } from '../../js/components/workspace-finish-dialog.js';
import '../../js/components/workspace-box-header.js';
import { setupRows, adoptSetupRow, probeSetupAdoptions, __setSetupOffersForTests } from '../../js/services/workspace-places.js';
import { buildPlaceRows, buildProviderFields, buildProvisionProgress } from '../../js/components/workspace-setup-form.js';
import { provisionWorkspace, provisionLeftBehind, finishWorkspace } from '../../js/services/workspace-provisioning.js';
import workspaceProviderRegistry from '../../js/registries/workspace-provider-registry.js';
import WorkspaceProvider from '../../sdk/workspace-provider.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';
import { assert, waitFor } from '../utilities/test-helpers.js';
import { underPseudoLocale, shownStrings } from '../utilities/pseudo-locale.js';

const PROVIDER_ID = 'i18n-dialogs-provider';

/** A provider that finds one place with no workspace, and makes nothing. */
class FindsOnePlace extends WorkspaceProvider {
  static MANIFEST = {
    id: PROVIDER_ID,
    name: 'Somewhere, for testing',
    version: '1.0.0',
    description: 'Finds one place so the reconnect dialog has an offer to draw',
  };

  /** @type {boolean} Whether reconcile reports the place. */
  static offering = false;

  /**
   * @param {any[]} workspaces - This provider's rows.
   * @returns {Promise<any>} One orphaned artifact while offering, else none.
   */
  async reconcile(workspaces) {
    void workspaces;
    return {
      orphanedWorkspaces: [],
      orphanedArtifacts: FindsOnePlace.offering
        ? [{ id: 'i18n-dialogs-1', label: '8', detail: '9', workspace: { root: '/2/8', label: '8', meta: {} } }]
        : [],
      confirmed: [],
    };
  }
}

const DIRTY_PROVIDER_ID = 'i18n-dialogs-dirty-provider';

/** A provider whose every tree holds uncommitted work. */
class HoldsWork extends WorkspaceProvider {
  static MANIFEST = {
    id: DIRTY_PROVIDER_ID,
    name: 'Dirty, for testing',
    version: '1.0.0',
    description: 'Reports uncommitted work so a box header draws its mark',
  };

  /**
   * @param {any} workspace - The row being reported on.
   * @returns {Promise<any>} Uncommitted work, always.
   */
  async status(workspace) {
    void workspace;
    return { dirty: true };
  }
}

const PLACES_EXTENSION = 'test-i18n-places';
const PLACES_PROVIDER_ID = 'i18n-places-provider';

/** A provider that says what it is good for, and finds a place it once parked. */
class AdvisesAndFinds extends WorkspaceProvider {
  static MANIFEST = {
    id: PLACES_PROVIDER_ID,
    name: 'Advises, for testing',
    version: '1.0.0',
    description: 'Makes a place for the place list to describe',
    setupLabel: 'New place, for testing',
    recommendations: {
      bestFor: 'checking what a place list says',
      avoidFor: 'anything that matters',
      notes: ['Nothing is made on disk.'],
    },
  };

  /**
   * @param {any[]} workspaces - This provider's rows.
   * @returns {Promise<any>} The parked place, as something to adopt.
   */
  async reconcile(workspaces) {
    void workspaces;
    return {
      orphanedWorkspaces: [],
      orphanedArtifacts: [{ id: 'i18n-places-1', label: '8', detail: '9', workspace: { root: '/3/8', label: '8', meta: {} } }],
      confirmed: [],
    };
  }
}

const BASE_PROVIDER_ID = 'i18n-base-provider';

/**
 * A provider that overrides only `provision`, so every other sentence it says
 * is the base class's. Its name is a digit: a manifest name is translated by
 * its readers, not by the base class that quotes it.
 */
class LeansOnBase extends WorkspaceProvider {
  static MANIFEST = {
    id: BASE_PROVIDER_ID,
    name: '4',
    version: '1.0.0',
    description: 'Says only what the base class says',
  };

  /**
   * Fail, after a step whose undoing fails too.
   * @param {any} values - Unused.
   * @param {any} ctx - The provisioner's context.
   * @returns {Promise<any>} Never resolves.
   */
  async provision(values, ctx) {
    void values;
    ctx.rollback.push(() => { throw new Error('7'); });
    throw new Error('6');
  }
}

const ENDS_PROVIDER_ID = 'i18n-ends-provider';

/**
 * A provider with two endings that say nothing of their own: `bin` leaves the
 * conversations to be binned, `return` hands them back. What is said is then
 * the host's alone.
 */
class EndsBothWays extends WorkspaceProvider {
  static MANIFEST = {
    id: ENDS_PROVIDER_ID,
    name: '4',
    version: '1.0.0',
    description: 'Ends without a word, so the host is the one speaking',
  };

  /**
   * @param {any} workspace - Unused.
   * @param {string} actionId - Which ending.
   * @returns {Promise<any>} Done, handing the conversations back for `return`.
   */
  async finish(workspace, actionId) {
    void workspace;
    return actionId === 'return' ? { done: true, conversations: 'return' } : { done: true };
  }
}

const FOREIGN_PROVIDER_ID = 'i18n-foreign-provider';

/**
 * Another suite's provider, which finds a tree and says so in English — what a
 * git-worktree suite earlier in the same lane leaves on the offer table.
 */
class AnotherSuites extends WorkspaceProvider {
  static MANIFEST = {
    id: FOREIGN_PROVIDER_ID,
    name: 'Another suite, for testing',
    version: '1.0.0',
    description: 'Leaves an offer behind, as a sibling suite in the lane would',
  };

  /**
   * @param {any[]} workspaces - This provider's rows.
   * @returns {Promise<any>} One stray tree, described in English.
   */
  async reconcile(workspaces) {
    void workspaces;
    return {
      orphanedWorkspaces: [],
      orphanedArtifacts: [{
        id: 'i18n-foreign-1',
        label: 'feat/tunnels',
        detail: '/9/feat-tunnels — a worktree of 9 with no workspace',
        workspace: { root: '/9/feat-tunnels', label: 'feat/tunnels', meta: {} },
      }],
      confirmed: [],
    };
  }
}

/**
 * Put another suite's offer on the table, the way that suite would: its
 * provider is registered alone for one probe, then the registry is put back.
 * @returns {Promise<void>} When the offer is on the table.
 */
async function seedForeignOffer() {
  const registry = /** @type {any} */ (workspaceProviderRegistry);
  const savedItems = new Map(registry.items);
  const savedExtensions = new Map(registry.itemExtensions);
  const savedPaths = new Map(registry.modulePaths);
  registry.items.clear();
  try {
    const added = registry.registerClass(AnotherSuites, { extensionId: 'test-i18n-foreign', modulePath: '(test)' });
    assert(added.registered, `the foreign provider registered, got ${JSON.stringify(added)}`);
    await probeSetupAdoptions({ projectPath: '/1', workspaces: [] });
  } finally {
    registry.items.clear();
    for (const [k, v] of savedItems) registry.items.set(k, v);
    registry.itemExtensions.clear();
    for (const [k, v] of savedExtensions) registry.itemExtensions.set(k, v);
    registry.modulePaths.clear();
    for (const [k, v] of savedPaths) registry.modulePaths.set(k, v);
  }
}

/**
 * Give a case an offer table of its own: the lane's — with another suite's
 * offer always on it, so a case that leaks the lane's table fails alone too —
 * is swapped for an empty one.
 * @returns {Promise<() => void>} Puts the lane's table back, without the seeded offer.
 */
async function ownOfferTable() {
  await seedForeignOffer();
  const lane = __setSetupOffersForTests(new Map());
  return () => {
    __setSetupOffersForTests(new Map([...lane].filter(([, offer]) => offer.providerId !== FOREIGN_PROVIDER_ID)));
  };
}

/**
 * A JSON response, as the server would send it.
 * @param {number} status - HTTP status.
 * @param {any} body - The body.
 * @returns {Response} The response.
 */
const json = (status, body) => new window.Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});

/**
 * Run the workspace-dialogs tests.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  /** @type {string[]} */
  const errors = [];
  let passed = 0;
  let failed = 0;

  /**
   * @param {string} name
   * @param {() => Promise<void>} fn
   */
  const run = async (name, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${name}: ${e instanceof Error ? `${e.message}\n${e.stack}` : String(e)}`);
    }
  };

  await run('en-XA: the move and reconnect dialogs draw no plain English in any state', async () => {
    // "Nothing on offer" is a state of the table, so the case owns the table.
    const restoreOffers = await ownOfferTable();
    const registry = /** @type {any} */ (workspaceProviderRegistry);
    const savedItems = new Map(registry.items);
    const savedExtensions = new Map(registry.itemExtensions);
    const savedPaths = new Map(registry.modulePaths);
    registry.items.clear();
    const added = registry.registerClass(FindsOnePlace, { extensionId: 'test', modulePath: '(test)' });
    const originalFetch = window.fetch;
    /** @type {'fail'|'succeed'} How the next register call is answered. */
    let register = 'fail';

    /** @type {{where: string, text: string}[]} */
    const shown = [];
    /**
     * Record everything a dialog shows in one state.
     * @param {string} where - The state.
     * @param {string} [skip] - Data to leave out.
     */
    const collect = (where, skip) => {
      const root = document.querySelector('.workspace-move-overlay');
      assert(root, `a dialog on screen (${where})`);
      const texts = shownStrings(/** @type {Element} */ (root), skip);
      assert(texts.length >= 3, `the dialog drew something (${where}), got ${JSON.stringify(texts)}`);
      for (const text of texts) shown.push({ where, text });
    };
    const overlay = () => /** @type {HTMLElement} */ (document.querySelector('.workspace-move-overlay'));

    try {
      assert(added.registered, `the stand-in provider registered, got ${JSON.stringify(added)}`);
      await underPseudoLocale('workspace-dialogs-test', async () => {
        window.fetch = /** @type {typeof fetch} */ (async (input, init) => {
          if (String(input).includes('/session/workspaces') && init?.method === 'POST') {
            return register === 'fail'
              ? json(409, { error: '7' })
              : json(200, { workspace: { id: 'ws_lost', root: '/2/8', label: '8', state: 'ready', providerId: PROVIDER_ID } });
          }
          return originalFetch(input, init);
        });

        // ---- Move: from a workspace to the project folder. ----
        const session = {
          projectPath: '/1',
          workspaces: [],
          getWorkspace: (/** @type {string} */ id) => (id === 'ws_from' ? { id, label: '4', root: '/5/6' } : undefined),
          workspaceRoot: (/** @type {string} */ id) => (id === 'ws_from' ? '/5/6' : id ? '' : '/1'),
        };
        let throwOnAsk = false;
        let busy = false;
        /** @type {any} */
        const moving = {
          session,
          workspaceId: 'ws_from',
          get isProcessing() {
            if (throwOnAsk) throw new Error('7');
            return busy;
          },
        };
        /**
         * Press Move on the dialog on screen and record the refusal it draws.
         * @param {string} where - The refusal.
         */
        const refusal = async (where) => {
          /** @type {HTMLButtonElement} */ (overlay().querySelector('.workspace-move-commit')).click();
          await waitFor(() => !!overlay()?.querySelector('.setup-error'), { description: `the refusal (${where})` });
          shown.push({ where, text: overlay().querySelector('.setup-error')?.textContent || '' });
        };
        const toProject = openWorkspaceMove(moving, '');
        const dataSkip = '.workspace-move-from .workspace-move-now-label, .workspace-move-now-path';
        collect('move, to the project folder', dataSkip);

        // Pressed: the busy redraw happens before the first await, so it is on
        // screen when the click returns; the throw then lands as the error.
        throwOnAsk = true;
        /** @type {HTMLButtonElement} */ (overlay().querySelector('.workspace-move-commit')).click();
        assert(/** @type {HTMLButtonElement} */ (overlay().querySelector('.workspace-move-commit')).disabled,
          'the press disables Move while it is in flight');
        collect('move, in flight', dataSkip);
        await waitFor(() => !!overlay()?.querySelector('.setup-error'), { description: 'the refusal' });
        assert(overlay().querySelector('.setup-error')?.textContent === '7',
          `the error is shown as given, got ${JSON.stringify(overlay().querySelector('.setup-error')?.textContent)}`);
        collect('move, refused', `${dataSkip}, .setup-error`);

        // The service's own refusals, pressed again: a turn in flight, then a
        // conversation that has lost its session.
        throwOnAsk = false;
        busy = true;
        await refusal('move, refused mid-turn');
        busy = false;
        moving.session = undefined;
        await refusal('move, refused with no session');
        moving.session = session;
        /** @type {HTMLElement} */ (overlay().querySelector('.workspace-move-cancel')).click();
        assert((await toProject).moved === false, 'cancelling the move moves nothing');

        // A workspace that cannot be worked in refuses the conversation.
        const toNowhere = openWorkspaceMove({ session, workspaceId: '', isProcessing: false }, 'ws_gone');
        await refusal('move, refused into a workspace with no tree');
        /** @type {HTMLElement} */ (overlay().querySelector('.workspace-move-cancel')).click();
        assert((await toNowhere).moved === false, 'a refused move moves nothing');

        // ---- Move: from the project folder to a workspace. ----
        const fromProject = { session, workspaceId: '', isProcessing: false };
        const toWorkspace = openWorkspaceMove(fromProject, 'ws_from');
        collect('move, to a workspace', '.workspace-move-to .workspace-move-now-label, .workspace-move-now-path');
        /** @type {HTMLElement} */ (overlay().querySelector('.workspace-move-close')).click();
        assert((await toWorkspace).moved === false, 'closing the move moves nothing');

        // ---- Reconnect: one conversation, nothing on offer. ----
        const lost = { id: 'c1', workspaceId: 'ws_lost', session: /** @type {any} */ (null) };
        const lonely = { conversations: new Map([['c1', lost]]), workspaces: [], projectPath: '/1' };
        lost.session = lonely;
        FindsOnePlace.offering = false;
        const alone = openWorkspaceReconnect(lost);
        assert(!overlay().querySelector('.setup-row') && overlay().querySelector('.setup-row-detail'),
          'with nothing on offer, the dialog offers nothing and says so');
        collect('reconnect, one conversation, nothing on offer');
        /** @type {HTMLElement} */ (overlay().querySelector('.workspace-move-cancel')).click();
        assert((await alone).reconnected === false, 'cancelling reconnects nothing');

        // ---- Reconnect: three conversations, one place on offer. ----
        const many = { conversations: new Map(), workspaces: /** @type {any[]} */ ([]), projectPath: '/1' };
        for (const id of ['c1', 'c2', 'c3']) many.conversations.set(id, { id, workspaceId: 'ws_lost', session: many });
        const stranded = many.conversations.get('c1');
        FindsOnePlace.offering = true;
        const mine = `.setup-choice:not(:has([data-row-id*="${PROVIDER_ID}"]))`;
        const offered = openWorkspaceReconnect(stranded);
        try {
          await waitFor(() => !!overlay()?.querySelector(`[data-row-id*="${PROVIDER_ID}"]`),
            { description: 'the stand-in place to be offered' });
          const offer = () => /** @type {HTMLElement} */ (overlay().querySelector(`[data-row-id*="${PROVIDER_ID}"]`));
          collect('reconnect, three conversations, a place on offer',
            `.setup-row-label, [data-row-id*="${PROVIDER_ID}"] .setup-row-detail, ${mine}`);

          // The server refuses: its answer is shown as given.
          register = 'fail';
          offer().click();
          await waitFor(() => !!overlay()?.querySelector('.setup-error'), { description: 'the server refusal' });
          collect('reconnect, refused by the server',
            `.setup-row-label, [data-row-id*="${PROVIDER_ID}"] .setup-row-detail, ${mine}, .setup-error`);

          // The offer is taken elsewhere, then the stale row is pressed.
          const stale = offer();
          register = 'succeed';
          const rowId = String(stale.dataset.rowId);
          assert(await adoptSetupRow(many, rowId), 'the offer is taken from under the dialog');
          stale.click();
          await waitFor(() => !overlay()?.querySelector(`[data-row-id*="${PROVIDER_ID}"]`)
            && !!overlay()?.querySelector('.setup-error'), { description: 'the "no longer on offer" error' });
          collect('reconnect, the place went', mine);
          /** @type {HTMLElement} */ (overlay().querySelector('.workspace-move-close')).click();
          assert((await offered).reconnected === false, 'closing reconnects nothing');
        } finally {
          // The offer table outlives this suite; leave nothing of ours on it.
          register = 'succeed';
          for (const row of setupRows(many)) {
            if (row.kind === 'adopt' && String(row.id).includes(PROVIDER_ID)) {
              await adoptSetupRow(many, row.id).catch(() => {});
            }
          }
          FindsOnePlace.offering = false;
        }
      });
    } finally {
      window.fetch = originalFetch;
      document.querySelectorAll('.workspace-move-overlay').forEach((el) => el.remove());
      restoreOffers();
      registry.items.clear();
      for (const [k, v] of savedItems) registry.items.set(k, v);
      registry.itemExtensions.clear();
      for (const [k, v] of savedExtensions) registry.itemExtensions.set(k, v);
      registry.modulePaths.clear();
      for (const [k, v] of savedPaths) registry.modulePaths.set(k, v);
    }

    const raw = shown.filter(({ text }) => !isPseudoLocalized(text));
    assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
  });

  await run('en-XA: the finish dialog draws no plain English in any state', async () => {
    /** @type {{where: string, text: string}[]} */
    const shown = [];
    const overlay = () => /** @type {HTMLElement} */ (document.querySelector('.workspace-finish-overlay'));
    /**
     * Record everything the dialog shows in one state. What the ending
     * declares and the file list's rows are data, written as digits, so a
     * string of digits alone is the fixture's, not a message.
     * @param {string} where - The state.
     */
    const collect = (where) => {
      const root = overlay();
      assert(root, `a dialog on screen (${where})`);
      const texts = shownStrings(root).filter((text) => !/^[\d/\s]+$/.test(text));
      assert(texts.length >= 3, `the dialog drew something (${where}), got ${JSON.stringify(texts)}`);
      for (const text of texts) shown.push({ where, text });
    };
    const cancel = () => /** @type {HTMLElement} */ (overlay().querySelector('.workspace-finish-cancel')).click();

    try {
      await underPseudoLocale('workspace-finish-dialog-test', async () => {
        // ---- Everything an ending can declare, over more files than are drawn. ----
        const files = Array.from({ length: 60 }, (_, i) => ({ state: '7', path: `/8/${i}` }));
        const full = openWorkspaceFinish({
          id: 'commit',
          label: '3',
          description: '4',
          prompt: {
            label: '5', placeholder: '6', confirmLabel: '9', multiline: true, requiresWork: true, hint: '2',
            alternative: { label: '1', hint: '0' },
          },
        }, { status: { dirty: true, files, fileCount: 1234 }, warning: '11', conversation: { id: 'c1' } });
        assert(overlay().querySelector('.workspace-finish-work-rest'), 'more files than are drawn says how many more');
        collect('every field declared, many files');
        cancel();
        assert((await full) === null, 'cancelling answers nothing');

        // ---- Nothing to commit, one file listed. ----
        const idle = openWorkspaceFinish({
          id: 'commit', label: '3', prompt: { requiresWork: true, alternative: { label: '1' } },
        }, { status: { dirty: false, files: [{ state: '7', path: '/8' }] }, conversation: { id: 'c1' } });
        assert(overlay().querySelector('.setup-field-note-error'), 'with nothing changed, the field says so');
        collect('nothing to commit, one file');
        cancel();
        await idle;

        // ---- An ending that declares nothing at all: every fallback. ----
        const bare = openWorkspaceFinish({ id: 'x' }, {});
        collect('nothing declared');
        /** @type {HTMLElement} */ (overlay().querySelector('.workspace-move-close')).click();
        await bare;
      });
    } finally {
      document.querySelectorAll('.workspace-finish-overlay').forEach((el) => el.remove());
    }

    const raw = shown.filter(({ text }) => !isPseudoLocalized(text));
    assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
  });

  await run('en-XA: a workspace box header holding uncommitted work says so in the UI language', async () => {
    const registry = /** @type {any} */ (workspaceProviderRegistry);
    const savedItems = new Map(registry.items);
    const savedExtensions = new Map(registry.itemExtensions);
    const savedPaths = new Map(registry.modulePaths);
    const added = registry.registerClass(HoldsWork, { extensionId: 'test', modulePath: '(test)' });
    const holder = document.createElement('div');
    document.body.appendChild(holder);

    /** @type {string[]} */
    let texts = [];
    try {
      assert(added.registered, `the stand-in provider registered, got ${JSON.stringify(added)}`);
      await underPseudoLocale('workspace-box-header-test', async () => {
        const header = /** @type {any} */ (document.createElement('workspace-box-header'));
        holder.appendChild(header);
        header.setContext({
          session: {},
          workspace: { id: 'ws_dirty', label: '8', root: '/8', state: 'ready', providerId: DIRTY_PROVIDER_ID },
        });
        await waitFor(() => header.classList.contains('is-dirty'), { description: 'the uncommitted-work mark' });
        assert(header.getAttribute('title'), 'a header holding work has a tooltip saying so');
        texts = shownStrings(holder).filter((text) => !/^[\d/\s]+$/.test(text));
      });
    } finally {
      holder.remove();
      registry.items.clear();
      for (const [k, v] of savedItems) registry.items.set(k, v);
      registry.itemExtensions.clear();
      for (const [k, v] of savedExtensions) registry.itemExtensions.set(k, v);
      registry.modulePaths.clear();
      for (const [k, v] of savedPaths) registry.modulePaths.set(k, v);
    }

    assert(texts.length >= 1, `the header showed its tooltip, got ${JSON.stringify(texts)}`);
    const raw = texts.filter((text) => !isPseudoLocalized(text));
    assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
  });

  await run('en-XA: the place list, a provider\'s advice and the progress block draw no plain English', async () => {
    // Pinned: only the stand-in provider is registered, under an extension id
    // whose catalogue the case supplies, so every provider-supplied word is
    // proved to go through that extension's catalogue. The offer table is
    // pinned the same way, so the adopt row drawn is the stand-in's alone.
    const restoreOffers = await ownOfferTable();
    const registry = /** @type {any} */ (workspaceProviderRegistry);
    const savedItems = new Map(registry.items);
    const savedExtensions = new Map(registry.itemExtensions);
    const savedPaths = new Map(registry.modulePaths);
    registry.items.clear();
    const added = registry.registerClass(AdvisesAndFinds, { extensionId: PLACES_EXTENSION, modulePath: '(test)' });
    const originalFetch = window.fetch;
    const { MANIFEST } = AdvisesAndFinds;
    const holder = document.createElement('div');
    document.body.appendChild(holder);
    // A place this project parked: its artifact comes back as an adopt row.
    const session = {
      projectPath: '/1',
      workspaces: /** @type {any[]} */ ([{ id: 'ws_parked', root: '/3/8', label: '8', state: 'closed', providerId: PLACES_PROVIDER_ID }]),
    };

    /** @type {string[]} */
    let texts = [];
    try {
      assert(added.registered, `the stand-in provider registered, got ${JSON.stringify(added)}`);
      await underPseudoLocale('workspace-places-test', async () => {
        window.fetch = /** @type {typeof fetch} */ (async (input, init) => {
          if (String(input).includes('/session/workspaces') && init?.method === 'POST') {
            return json(200, { workspace: { id: 'ws_back', root: '/3/8', label: '8', state: 'ready', providerId: PLACES_PROVIDER_ID } });
          }
          return originalFetch(input, init);
        });
        try {
          await probeSetupAdoptions(session);
          const rows = setupRows(session);
          const adopts = rows.filter((row) => row.kind === 'adopt');
          assert(adopts.length === 1 && adopts[0].providerId === PLACES_PROVIDER_ID,
            `the parked place is offered, and nothing else is, got ${JSON.stringify(rows)}`);
          assert(rows.some((row) => row.kind === 'new'), `the stand-in offers a "New…" row, got ${JSON.stringify(rows)}`);
          holder.appendChild(buildPlaceRows({ rows, selection: '', label: '5', onSelect: () => {}, onAdopt: () => {} }));
          assert(holder.querySelectorAll('.setup-row-meaning').length === 3,
            'the project, the parked place and the "New…" row each say what choosing them means');
          assert(holder.querySelector('.setup-row-verb'), 'the offer says what taking it does');

          const fields = buildProviderFields({ session, providerId: PLACES_PROVIDER_ID });
          holder.appendChild(fields.element);
          assert(fields.element.querySelector('.setup-recommend-for')
            && fields.element.querySelector('.setup-recommend-against')
            && fields.element.querySelector('.setup-recommend-note'), 'the form gives all three kinds of advice');
          holder.appendChild(buildProviderFields({ session, providerId: 'i18n-not-a-provider' }).element);
          holder.appendChild(buildProvisionProgress([{ step: '7', detail: '6' }], () => {}));
          texts = shownStrings(holder).filter((text) => !/^[\d/\s]+$/.test(text));
        } finally {
          // The offer table outlives this suite; leave nothing of ours on it.
          for (const row of setupRows(session)) {
            if (row.kind === 'adopt' && String(row.id).includes(PLACES_PROVIDER_ID)) {
              await adoptSetupRow(session, row.id).catch(() => {});
            }
          }
        }
      }, {
        [PLACES_EXTENSION]: [MANIFEST.setupLabel, MANIFEST.description, MANIFEST.recommendations.bestFor,
          MANIFEST.recommendations.avoidFor, ...MANIFEST.recommendations.notes],
      });
    } finally {
      window.fetch = originalFetch;
      holder.remove();
      restoreOffers();
      registry.items.clear();
      for (const [k, v] of savedItems) registry.items.set(k, v);
      registry.itemExtensions.clear();
      for (const [k, v] of savedExtensions) registry.itemExtensions.set(k, v);
      registry.modulePaths.clear();
      for (const [k, v] of savedPaths) registry.modulePaths.set(k, v);
    }

    assert(texts.length >= 10, `the list, the forms and the progress drew something, got ${JSON.stringify(texts)}`);
    const raw = texts.filter((text) => !isPseudoLocalized(text));
    assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
  });

  await run('en-XA: the base provider\'s own sentences, and what a failed provision left behind, are translated', async () => {
    // The base class draws nothing itself: its finish refusal reaches the panel's
    // notice and the left-behind sentence the create dialog — each as given. So the sentences are checked as said.
    const registry = /** @type {any} */ (workspaceProviderRegistry);
    const savedItems = new Map(registry.items);
    const savedExtensions = new Map(registry.itemExtensions);
    const savedPaths = new Map(registry.modulePaths);
    registry.items.clear();
    const added = registry.registerClass(LeansOnBase, { extensionId: 'test-i18n-base', modulePath: '(test)' });
    const originalFetch = window.fetch;
    const session = /** @type {any} */ ({
      projectPath: '/1',
      workspaces: [],
      workspaceRoot: (/** @type {string} */ id) => (id ? '' : '/1'),
    });
    const workspace = /** @type {any} */ ({ id: 'ws_base', root: '/1/2', label: '3', state: 'provisioning', providerId: BASE_PROVIDER_ID, meta: {} });

    /** @type {{where: string, text: string}[]} */
    const said = [];
    try {
      assert(added.registered, `the stand-in provider registered, got ${JSON.stringify(added)}`);
      await underPseudoLocale('workspace-provider-base-test', async () => {
        window.fetch = /** @type {typeof fetch} */ (async (input, init) => {
          if (String(input).includes('/session/workspaces')) {
            if (init?.method === 'POST') {
              return json(200, { workspace: { id: 'ws_base', root: '/1', label: '3', state: 'provisioning', providerId: BASE_PROVIDER_ID } });
            }
            return json(200, { workspace: { id: 'ws_base' } });
          }
          return originalFetch(input, init);
        });

        const provider = new LeansOnBase({ session });
        const finished = await provider.finish(workspace, '5', /** @type {any} */ ({}));
        assert(finished.done === false, 'an ending it does not have is refused');
        said.push({ where: 'finish', text: String(finished.message) });
        const cleaned = await provider.cleanupPartial(workspace, /** @type {any} */ ({}));
        assert(cleaned.removed === false, 'a provider with no cleanup removes nothing');

        /** @type {any} */
        let thrown = null;
        try {
          await provisionWorkspace({ session, providerId: BASE_PROVIDER_ID, values: {}, baseWorkspaceId: '', label: '3' });
        } catch (error) {
          thrown = error;
        }
        assert(thrown?.message === '6', `the provision's own error is what is thrown, got ${JSON.stringify(thrown?.message)}`);
        said.push({ where: 'leftBehind', text: provisionLeftBehind(thrown) });
      });
    } finally {
      window.fetch = originalFetch;
      registry.items.clear();
      for (const [k, v] of savedItems) registry.items.set(k, v);
      registry.itemExtensions.clear();
      for (const [k, v] of savedExtensions) registry.itemExtensions.set(k, v);
      registry.modulePaths.clear();
      for (const [k, v] of savedPaths) registry.modulePaths.set(k, v);
    }

    const byWhere = Object.fromEntries(said.map(({ where, text }) => [where, text]));
    // The data rides inside the wrapper: the provider's name, the action, the reason.
    assert(byWhere.finish?.includes('4') && byWhere.finish.includes('5'), `the refusal names the provider and the ending, got ${JSON.stringify(byWhere.finish)}`);
    assert(byWhere.leftBehind?.includes('7'), `what could not be undone is carried, got ${JSON.stringify(byWhere.leftBehind)}`);
    const raw = said.filter(({ text }) => !isPseudoLocalized(text));
    assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
  });

  await run('en-XA: what finishing with a workspace says, and why a provision cannot start, are translated', async () => {
    // The host's half of a finish — which conversations could not go, who is
    // mid-turn — reaches the panel's notice as said, and the
    // provision throws reach the create dialog's error, so each is checked as
    // said. Every conversation is a stand-in and every write is stubbed: the
    // bin by the stand-in session, the move by a session whose roots make it a
    // same-tree move, the tombstone by a fetch stub.
    const registry = /** @type {any} */ (workspaceProviderRegistry);
    const savedItems = new Map(registry.items);
    const savedExtensions = new Map(registry.itemExtensions);
    const savedPaths = new Map(registry.modulePaths);
    registry.items.clear();
    const added = registry.registerClass(EndsBothWays, { extensionId: 'test-i18n-ends', modulePath: '(test)' });
    const originalFetch = window.fetch;
    /** @type {typeof fetch} */
    const stubbed = async (input, init) => {
      if (String(input).includes('/session/workspaces/') && init?.method === 'PATCH') {
        return json(200, { workspace: { id: 'ws_ends', state: 'closed' } });
      }
      return originalFetch(input, init);
    };

    /**
     * Finish with a workspace holding the given conversations.
     * @param {'bin'|'home'|'project'} ending - Binned, or returned to which place.
     * @param {Array<{id: string, name: string, fate: 'ok'|'refused'|'throws'|'busy'}>} bound - The conversations.
     * @returns {Promise<string>} What the finish said.
     */
    const finish = async (ending, bound) => {
      const home = ending === 'home' ? 'ws_home' : '';
      // Every root is one tree, so a move back is the same-tree kind that writes nothing.
      const roots = (/** @type {string} */ id) => (id === 'ws_ends' || id === 'ws_home' || id === '' ? '/1' : '');
      /** @type {any} */
      const session = {
        projectPath: '/1',
        workspaces: [],
        conversations: new Map(),
        workspaceRoot: roots,
        binConversation: async (/** @type {string} */ id) => {
          const fate = bound.find((c) => c.id === id)?.fate;
          if (fate === 'throws') throw new Error('8');
          return fate === 'ok';
        },
      };
      const broken = { workspaceRoot: () => { throw new Error('8'); } };
      for (const { id, name, fate } of bound) {
        session.conversations.set(id, {
          id,
          name,
          workspaceId: 'ws_ends',
          isProcessing: fate === 'busy',
          // A conversation with no session is refused the move; one whose
          // session throws makes the move throw.
          session: fate === 'refused' ? undefined : fate === 'throws' ? broken : session,
        });
      }
      const workspace = { id: 'ws_ends', root: '/1', label: '3', state: 'ready', providerId: ENDS_PROVIDER_ID, baseWorkspaceId: home, meta: {} };
      const result = await finishWorkspace({ session, workspace, actionId: ending === 'bin' ? 'bin' : 'return' });
      return String(result.message ?? '');
    };

    /** @type {Record<string, string>} */
    const english = {};
    /** @type {{where: string, text: string}[]} */
    const said = [];
    try {
      assert(added.registered, `the stand-in provider registered, got ${JSON.stringify(added)}`);

      // English first: every place crossed with one and many, byte for byte.
      window.fetch = stubbed;
      for (const ending of /** @type {const} */ (['bin', 'home', 'project'])) {
        english[`${ending} 1`] = await finish(ending, [{ id: '91', name: '5', fate: 'ok' }]);
        english[`${ending} 3`] = await finish(ending, [
          { id: '91', name: '5', fate: 'ok' }, { id: '92', name: '6', fate: 'ok' }, { id: '93', name: '', fate: 'ok' },
        ]);
      }
      window.fetch = originalFetch;

      await underPseudoLocale('workspace-finish-messages-test', async () => {
        window.fetch = stubbed;
        // One moved, and one stuck each way: by refusal, by failure, by a throw.
        said.push({ where: 'bin, one moved, two stuck', text: await finish('bin', [
          { id: '91', name: '5', fate: 'ok' }, { id: '92', name: 'Untitled 3', fate: 'refused' }, { id: '9', name: '', fate: 'throws' },
        ]) });
        said.push({ where: 'home, one moved, two stuck', text: await finish('home', [
          { id: '91', name: '5', fate: 'ok' }, { id: '92', name: '7', fate: 'refused' }, { id: '93', name: 'Untitled 3', fate: 'throws' },
        ]) });
        said.push({ where: 'project, one moved, one stuck', text: await finish('project', [
          { id: '91', name: '5', fate: 'ok' }, { id: '9', name: '', fate: 'throws' },
        ]) });
        // A turn in flight refuses the finish, naming who is mid-turn.
        said.push({ where: 'busy, one', text: await finish('bin', [{ id: '92', name: 'Untitled 3', fate: 'busy' }]) });
        said.push({ where: 'busy, three', text: await finish('bin', [
          { id: '92', name: 'Untitled 3', fate: 'busy' }, { id: '93', name: '7', fate: 'busy' }, { id: '9', name: '', fate: 'busy' },
        ]) });

        // Both reasons a provision cannot start.
        for (const [where, request] of /** @type {Array<[string, any]>} */ ([
          ['provision, no provider', { session: { workspaceRoot: () => '/1' }, providerId: '9' }],
          ['provision, base unusable', { session: { workspaceRoot: () => '' }, providerId: ENDS_PROVIDER_ID, baseWorkspaceId: '5' }],
        ])) {
          /** @type {any} */
          let thrown = null;
          try {
            await provisionWorkspace(request);
          } catch (error) {
            thrown = error;
          }
          assert(thrown instanceof Error, `${where}: the provision threw`);
          said.push({ where, text: String(thrown?.message) });
        }
      });
    } finally {
      window.fetch = originalFetch;
      registry.items.clear();
      for (const [k, v] of savedItems) registry.items.set(k, v);
      registry.itemExtensions.clear();
      for (const [k, v] of savedExtensions) registry.itemExtensions.set(k, v);
      registry.modulePaths.clear();
      for (const [k, v] of savedPaths) registry.modulePaths.set(k, v);
    }

    // Where they went is the confirm's to say, before the finish: one where
    // every conversation went says nothing after it.
    const spoke = Object.entries(english).filter(([, text]) => text !== '');
    assert(Object.keys(english).length === 6 && spoke.length === 0,
      `a finish where everything went says nothing, got ${JSON.stringify(english)}`);

    const byWhere = Object.fromEntries(said.map(({ where, text }) => [where, text]));
    // The data rides inside the wrapper: names, ids and reasons.
    assert(byWhere['bin, one moved, two stuck']?.includes('3') && byWhere['bin, one moved, two stuck'].includes('9')
      && byWhere['bin, one moved, two stuck'].includes('8'), `the bin's stuck names and reason are carried, got ${JSON.stringify(byWhere['bin, one moved, two stuck'])}`);
    assert(byWhere['home, one moved, two stuck']?.includes('7') && byWhere['home, one moved, two stuck'].includes('8'),
      `the move's stuck names and reason are carried, got ${JSON.stringify(byWhere['home, one moved, two stuck'])}`);
    assert(byWhere['busy, three']?.includes('7') && byWhere['busy, three'].includes('9'),
      `the mid-turn refusal names them, got ${JSON.stringify(byWhere['busy, three'])}`);
    assert(byWhere['provision, no provider']?.includes('9'), `the throw names the provider, got ${JSON.stringify(byWhere['provision, no provider'])}`);
    assert(said.length === 7 && said.every(({ text }) => text), `every state said something, got ${JSON.stringify(said)}`);
    const raw = said.filter(({ text }) => !isPseudoLocalized(text));
    assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
  });

  return { passed, failed, errors };
}
