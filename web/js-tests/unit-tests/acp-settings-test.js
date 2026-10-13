//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests for the ACP agents Settings tab's pure helpers: agent-name
 * validation, the form-state → AgentConfig builder, the whole-scope-map
 * producers for add / edit / delete / enable-toggle, the scope-of-a-listed-agent
 * lookup, and the status→dot-class mapping. The live round-trip (config write,
 * agent resolution, availability) is covered by the Go acp config/ops tests;
 * this pins the browser-side decision logic the tab depends on.
 * @module unit-tests/acp-settings-test
 */

import { assert } from '../utilities/test-helpers.js';
import {
  configFormToConfig as acpFormToConfig,
  upsertConfigEntry as acpUpsertMap,
  deleteConfigEntry as acpDeleteMap,
  setConfigEntryEnabled as acpSetEnabledMap,
  configScopeOf as acpScopeOf,
} from '../../js/components/config-tab.js';
import {
  validateAcpAgentName,
  acpDotClass,
  AcpTab,
} from '../../js/components/settings/subprocess-tabs.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';
import { underPseudoLocale, assertPseudoLocalized } from '../utilities/pseudo-locale.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Aggregated results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label - Test label
   * @param {() => (void | Promise<void>)} fn - Test body
   */
  const run = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // --- validateAcpAgentName -------------------------------------------------

  await run('name validation: accepts a normal name', () => {
    assert(validateAcpAgentName('gemini', []) === '', 'valid name rejected');
  });

  await run('name validation: rejects blank', () => {
    assert(validateAcpAgentName('   ', []) !== '', 'blank accepted');
  });

  await run('name validation: rejects whitespace', () => {
    assert(validateAcpAgentName('my agent', []) !== '', 'whitespace accepted');
  });

  await run('name validation: rejects slash (would break the model id)', () => {
    assert(validateAcpAgentName('a/b', []) !== '', 'slash accepted');
  });

  await run('name validation: does NOT reserve "juggler" (unlike MCP)', () => {
    assert(validateAcpAgentName('juggler', []) === '', 'agent names are model ids, not tool prefixes');
  });

  await run('name validation: enforces uniqueness within scope', () => {
    assert(validateAcpAgentName('gemini', ['gemini', 'zed']) !== '', 'duplicate accepted');
    assert(validateAcpAgentName('gemini', ['zed']) === '', 'non-duplicate rejected');
  });

  // --- acpFormToConfig ------------------------------------------------------

  await run('form→config: trims command, keeps args verbatim, omits empties', () => {
    const entry = acpFormToConfig({ command: '  gemini ', args: ['--experimental-acp', 'a b'], env: {}, enabled: true });
    assert(entry.command === 'gemini', 'command not trimmed');
    assert(Array.isArray(entry.args) && entry.args.length === 2, 'args count wrong');
    assert(entry.args[1] === 'a b', 'arg with space was split/altered');
    assert(!('env' in entry), 'empty env should be omitted');
    assert(entry.enabled === true, 'enabled not set');
  });

  await run('form→config: omits empty args, includes non-empty env', () => {
    const entry = acpFormToConfig({ command: 'run', args: [], env: { API_KEY: 'secret' }, enabled: false });
    assert(!('args' in entry), 'empty args should be omitted');
    assert(entry.env && entry.env.API_KEY === 'secret', 'env not preserved');
    assert(entry.enabled === false, 'enabled=false not coerced');
  });

  await run('form→config: drops blank env keys and filters blank args', () => {
    const entry = acpFormToConfig({ command: 'run', args: ['a', '', 'b'], env: { '': 'x', OK: 'y' } });
    assert(entry.args.length === 2 && entry.args[0] === 'a' && entry.args[1] === 'b', 'blank arg not filtered');
    assert(entry.env && !('' in entry.env) && entry.env.OK === 'y', 'blank env key not dropped');
    assert(entry.enabled === true, 'enabled should default true');
  });

  // --- whole-scope-map producers -------------------------------------------

  await run('upsert map: adds without touching siblings, clones', () => {
    const src = { zed: { command: 'zed' } };
    const out = acpUpsertMap(src, 'gemini', { command: 'gemini' });
    assert(out.zed && out.zed.command === 'zed', 'sibling lost on add');
    assert(out.gemini && out.gemini.command === 'gemini', 'new entry missing');
    assert(src.gemini === undefined, 'source mutated (not cloned)');
  });

  await run('upsert map: replaces an existing entry', () => {
    const out = acpUpsertMap({ gemini: { command: 'old' } }, 'gemini', { command: 'new' });
    assert(out.gemini.command === 'new', 'entry not replaced');
  });

  await run('delete map: removes one, keeps the rest, clones', () => {
    const src = { zed: { command: 'zed' }, gemini: { command: 'gemini' } };
    const out = acpDeleteMap(src, 'gemini');
    assert(!('gemini' in out), 'target not deleted');
    assert(out.zed && out.zed.command === 'zed', 'sibling lost on delete');
    assert('gemini' in src, 'source mutated (not cloned)');
  });

  await run('set-enabled map: flips flag, preserves other config, clones', () => {
    const src = { gemini: { command: 'gemini', args: ['--experimental-acp'], enabled: true } };
    const out = acpSetEnabledMap(src, 'gemini', false);
    assert(out.gemini.enabled === false, 'flag not applied');
    assert(out.gemini.command === 'gemini' && out.gemini.args[0] === '--experimental-acp', 'other config lost');
    assert(src.gemini.enabled === true, 'source mutated (not cloned)');
  });

  await run('set-enabled map: works for a name not yet in the map', () => {
    const out = acpSetEnabledMap({}, 'new', true);
    assert(out.new && out.new.enabled === true, 'missing-key case not handled');
  });

  // --- acpScopeOf -----------------------------------------------------------

  await run('scope-of: project overrides global', () => {
    assert(acpScopeOf({ global: { gemini: {} }, project: { gemini: {} } }, 'gemini') === 'project', 'project override not detected');
  });

  await run('scope-of: falls back to global', () => {
    assert(acpScopeOf({ global: { gemini: {} }, project: {} }, 'gemini') === 'global', 'global not detected');
  });

  await run('scope-of: unknown name defaults to global', () => {
    assert(acpScopeOf({ global: {}, project: {} }, 'nope') === 'global', 'unknown should default global');
  });

  // --- acpDotClass ----------------------------------------------------------

  await run('dot class: maps status to the shared MCP dot classes', () => {
    assert(acpDotClass('available') === 'running', 'available should be green (running)');
    assert(acpDotClass('unavailable') === 'failed', 'unavailable should be red (failed)');
    assert(acpDotClass('disabled') === 'stopped', 'disabled should be grey (stopped)');
    assert(acpDotClass('anything-else') === 'stopped', 'unknown should default to stopped');
  });

  // --- en-XA: everything the ACP agents tab draws is a translated message -----
  // The real tab with its ops stubbed and its post-save hook (which enables the
  // ACP provider on the server) replaced, so nothing reaches the real server.
  // Agent names and agent errors are digit-only data, skipped where they stand
  // alone; example commands and env keys in placeholders are not messages.

  await run('en-XA: every state of the ACP agents tab is translated', async () => {
    await underPseudoLocale('acp-settings-test', async () => {
      const originalModal = /** @type {any} */ (window).showModal;
      const host = document.createElement('div');
      const formHost = document.createElement('div');
      formHost.id = 'acp-form';
      host.appendChild(formHost);
      document.body.appendChild(host);
      const tab = new AcpTab(host);
      const ctrl = tab.controller;
      const skip = [
        '.mcp-entry-name', '.provider-info > .mcp-error-hint', '.mcp-remove-row', '.mcp-reveal-btn',
        '.acp-name-input', '.acp-command-input', '.acp-arg-input', '.acp-env-key',
      ].join(', ');
      /** @param {string} where */
      const check = (where) => { assertPseudoLocalized(formHost, { skip, where }); };
      /**
       * @param {string} selector
       * @param {string} what
       */
      const translated = (selector, what) => {
        const el = formHost.querySelector(selector);
        assert(el, `nothing drawn for ${what}`);
        assert(isPseudoLocalized(el.textContent || ''), `${what}: ${JSON.stringify(el?.textContent)}`);
      };
      const formError = (/** @type {string} */ what) => translated('.mcp-form > .mcp-error-hint', what);
      const banner = (/** @type {string} */ what) => translated(':scope > .mcp-error-hint', what);
      try {
        /** @type {any[]} */
        let items = [];
        /** @type {any} */
        let config = { global: {}, project: {}, hasProject: true };
        let failList = false;
        let failSet = false;
        // Non-Error rejections reach the controller's own fallback messages.
        ctrl.spec = {
          ...ctrl.spec,
          ops: {
            list: async () => { if (failList) throw 'down'; return items; },
            getConfig: async () => config,
            setConfig: async (/** @type {any} */ _scope, /** @type {any} */ map) => {
              if (failSet) throw 'refused';
              config = { ...config, global: map };
            },
          },
          onAfterSave: async () => {},
        };

        await ctrl.refresh();
        assert(formHost.querySelector('.mcp-empty'), 'empty state not drawn');
        check('empty list');

        // Every status; no agent has a command, so each row says so.
        items = [
          { name: '1', status: 'available', enabled: true },
          { name: '2', status: 'unavailable', error: '9' },
          { name: '3', status: 'disabled', enabled: false },
          { name: '4' },
        ];
        config = { global: { 1: {}, 2: {}, 3: { enabled: false } }, project: { 4: {} }, hasProject: true };
        await ctrl.refresh();
        assert(formHost.querySelectorAll('.mcp-row').length === 4, 'rows not drawn');
        const rowErr = formHost.querySelector('.provider-info > .mcp-error-hint');
        assert(rowErr && rowErr.textContent === '9', `an agent's own error is data, was ${JSON.stringify(rowErr?.textContent)}`);
        check('populated list');

        failList = true;
        await ctrl.refresh();
        banner('load failure');
        failList = false;
        await ctrl.refresh();

        // A refresh is held off so an action's own error is what the banner shows.
        ctrl.busy = true;
        failSet = true;
        await ctrl._setEnabled('global', '1', false);
        ctrl.render();
        banner('toggle failure');

        /** @type {any} */
        let asked = null;
        /** @type {any} */ (window).showModal = async (/** @type {any} */ options) => { asked = options; return true; };
        await ctrl._confirmDelete('global', '1');
        assert(asked, 'no delete confirm');
        for (const key of ['title', 'message', 'confirmText']) {
          assert(isPseudoLocalized(String(asked[key] || '')), `delete confirm ${key}: ${JSON.stringify(asked[key])}`);
        }
        ctrl.render();
        banner('delete failure');
        ctrl.busy = false;
        failSet = false;
        await ctrl.refresh();

        // Add form with two argument rows (the second has its own placeholder)
        // and a variable row.
        ctrl.openForm('add');
        const [addArg, addEnv] = /** @type {HTMLElement[]} */ ([...formHost.querySelectorAll('.mcp-add-row')]);
        assert(addArg && addEnv, 'add-row buttons not drawn');
        addArg.click();
        addArg.click();
        addEnv.click();
        check('add form');
        const argInputs = /** @type {HTMLInputElement[]} */ ([...formHost.querySelectorAll('.acp-arg-input')]);
        assert(argInputs.length === 2, 'two argument rows expected');
        assert(isPseudoLocalized(argInputs[1].placeholder), `second argument placeholder: ${JSON.stringify(argInputs[1].placeholder)}`);
        const iconButtons = formHost.querySelectorAll('.mcp-remove-row, .mcp-reveal-btn');
        assert(iconButtons.length === 4, `expected 4 icon buttons, found ${iconButtons.length}`);
        for (const btn of iconButtons) {
          const label = btn.getAttribute('aria-label') || '';
          assert(isPseudoLocalized(label), `icon button aria-label: ${JSON.stringify(label)}`);
        }

        const field = (/** @type {string} */ cls) => /** @type {HTMLInputElement} */ (formHost.querySelector(`.acp-${cls}`));
        for (const [name, what] of [['', 'blank name'], ['a b', 'spaced name'], ['a/b', 'slashed name'], ['1', 'duplicate name']]) {
          field('name-input').value = name;
          await ctrl._save();
          formError(what);
        }
        field('name-input').value = '9';
        field('command-input').value = '';
        await ctrl._save();
        formError('missing command');
        field('command-input').value = '5';
        field('env-key').value = '';
        field('env-value').value = '5';
        await ctrl._save();
        formError('unnamed variable');
        field('env-value').value = '';
        failSet = true;
        await ctrl._save();
        formError('save failure');
        check('add form with an error');
        failSet = false;
        await ctrl._save();
        assert(!ctrl.editing, 'a valid save should close the form');

        ctrl.openForm('edit', { name: '1' });
        check('edit form');
      } finally {
        /** @type {any} */ (window).showModal = originalModal;
        tab.dispose();
        host.remove();
      }
    });
  });

  return { passed, failed, errors };
}
