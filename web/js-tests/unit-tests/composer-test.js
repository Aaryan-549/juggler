//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests for `<composer-box>` (`components/composer.js`): what the box
 * itself says — the Send button's title, the new-thread button's title, every
 * placeholder line, the blocked-input placeholder and the box's own warnings —
 * follows the UI language.
 *
 * The box is mounted with no conversation and no thread; each state is reached
 * by setting the one field it reads (a stand-in conversation's `isTurnActive`,
 * a stubbed placeholder state), and warnings are captured on the instance, so
 * nothing is sent and no notice is shown.
 * @module unit-tests/composer-test
 */

import { initializeRegistries, assert } from '../utilities/test-helpers.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';
import { underPseudoLocale, shownStrings } from '../utilities/pseudo-locale.js';
import slashCommandHandler from '../../js/services/slash-command-handler.js';
import '../../js/components/composer.js';

/** The id a stand-in built-in command is owned by, whose text is registered under it. */
const STAND_IN_EXTENSION = 'composer-test-ext';

/** Other components the box hosts, whose text is theirs to translate. */
const HOSTED = 'strategy-selector, permission-controls, model-selector, composer-config-strip, composer-box-attachments';

/** The placeholder states `_derivePlaceholderState()` can return. */
const PLACEHOLDER_STATES = ['fresh', 'ready', 'cancelled', 'error', 'idle', 'long'];

/**
 * Mount a `<composer-box>` off-screen, binding its listeners directly (rAF may
 * never pump in the hidden test window).
 * @returns {{box: any, container: HTMLElement, textarea: HTMLTextAreaElement, warnings: string[]}} The box, its container, its textarea, and the warnings it raised.
 */
function mountComposer() {
  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:600px;height:600px;';
  const box = /** @type {any} */ (document.createElement('composer-box'));
  container.appendChild(box);
  document.body.appendChild(container);
  box.setupListeners();
  box.setupListeners = () => {};
  /** @type {string[]} */
  const warnings = [];
  box.showWarning = (/** @type {string} */ m) => { warnings.push(m); };
  const textarea = /** @type {HTMLTextAreaElement} */ (box.querySelector('textarea'));
  assert(!!textarea, 'composer-box must render a textarea');
  return { box, container, textarea, warnings };
}

/**
 * Run the composer test suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  await initializeRegistries();

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

  await run('en-XA: the box\'s titles, placeholders and warnings draw no plain English', async () => {
    const { box, container, textarea, warnings } = mountComposer();
    try {
      await underPseudoLocale('composer-test', async () => {
        /** @type {Array<[string, string]>} */
        const shown = [];
        const sendBtn = /** @type {HTMLElement} */ (box.querySelector('#send-button'));
        const newThreadBtn = /** @type {HTMLElement} */ (box.querySelector('.new-thread-btn'));
        assert(!!sendBtn && !!newThreadBtn, 'the send and new-thread buttons must render');

        // Send button, idle and held with no reason given.
        box._updateSendButtonState();
        shown.push(['send title (idle)', sendBtn.getAttribute('title') || '']);
        shown.push(['send aria-label (idle)', sendBtn.getAttribute('aria-label') || '']);
        box.setSendBlocked(true);
        shown.push(['send title (held)', sendBtn.getAttribute('title') || '']);
        shown.push(['send aria-label (held)', sendBtn.getAttribute('aria-label') || '']);
        // A reason given by the caller is shown as given.
        box.setSendBlocked(true, '1');
        assert(sendBtn.getAttribute('title') === '1', `a held send's reason is shown as given: ${sendBtn.getAttribute('title')}`);
        box.setSendBlocked(false);

        // New-thread button, idle and while a turn runs.
        let busy = false;
        box._conversation = { isTurnActive: () => busy };
        try {
          box._updateNewThreadControls();
          shown.push(['new-thread title (idle)', newThreadBtn.title]);
          busy = true;
          box._updateNewThreadControls();
          shown.push(['new-thread title (busy)', newThreadBtn.title]);

          // Creating a thread while a turn runs is refused with a warning.
          box._createThread();
          assert(warnings.length === 1, `new-thread-while-busy warning: ${JSON.stringify(warnings)}`);
          shown.push(['new-thread-while-busy warning', warnings[0]]);
        } finally {
          box._conversation = null;
        }

        // Every line of every placeholder state; the pick is random, so walk
        // each bucket's indices through a pinned Math.random.
        const realRandom = Math.random;
        const realDerive = box._derivePlaceholderState;
        try {
          for (const state of PLACEHOLDER_STATES) {
            box._derivePlaceholderState = () => state;
            /** @type {Set<string>} */
            const lines = new Set();
            for (let k = 0; k < 8; k++) {
              Math.random = () => (k + 0.5) / 8;
              box._placeholderState = '';
              box._updatePlaceholder();
              lines.add(textarea.placeholder);
            }
            Math.random = realRandom;
            assert(lines.size >= 1, `placeholder state ${state} drew nothing`);
            for (const line of lines) shown.push([`placeholder (${state})`, line]);
          }
        } finally {
          Math.random = realRandom;
          box._derivePlaceholderState = realDerive;
        }

        // Input blocked, with no reason and with one (shown as given).
        box.setBlocked(true);
        shown.push(['blocked placeholder (no reason)', textarea.placeholder]);
        box.setBlocked(true, '2');
        assert(textarea.placeholder === '2', `a block's reason is shown as given: ${textarea.placeholder}`);
        box.setBlocked(false);

        // A message one character over the cap.
        warnings.length = 0;
        textarea.value = '3'.repeat(100_001);
        const result = await box.sendMessage();
        assert(result === 'message too large', `an oversized message is refused: ${result}`);
        assert(warnings.length === 1, `too-large warning: ${JSON.stringify(warnings.length)}`);
        shown.push(['too-large warning', warnings[0]]);
        assert(warnings[0].includes('100,001') && warnings[0].includes('100,000'),
          `the too-large warning carries both sizes: ${warnings[0]}`);
        textarea.value = '';

        const raw = shown.filter(([, s]) => !isPseudoLocalized(s));
        assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
      });
    } finally {
      container.remove();
    }
  });

  await run('en-XA: the controls, menus and actions sheet draw no plain English', async () => {
    const { box, container } = mountComposer();
    const handler = /** @type {any} */ (slashCommandHandler);
    const realInit = handler.init;
    const realGetCommands = handler.getCommands;
    const realThread = box._messageThread;
    /** @type {Array<{name: string, description: string}>} */
    let skills = [];
    // The thread's skill snapshot is read off its `skill` context item.
    class SkillStandIn {
      static MANIFEST = { id: 'skill' };
      async getSnapshotSkills() { return skills; }
    }
    try {
      handler.init = async () => {};
      handler.getCommands = () => [
        { name: '1', label: 'Stand-in command', description: 'Stand-in description', extensionId: STAND_IN_EXTENSION },
        { name: '2', label: '3', description: '4', userDefined: true, scope: 'user' },
      ];

      await underPseudoLocale('composer-test', async () => {
        /** @type {Array<[string, string]>} */
        const shown = [];
        /**
         * @param {string} where
         * @param {Element} root
         * @param {string} [skip]
         */
        const collect = (where, root, skip) => {
          for (const s of shownStrings(root, skip)) shown.push([where, s]);
        };
        // A command's `/name` and a skill's `$name` are identifiers; a user
        // command's label and a skill's description are the user's own.
        const data = 'code, li[data-command="2"], .skill-mention-item';
        /**
         * @param {Element} menu
         * @param {string} where
         */
        const userTextAsGiven = (menu, where) => {
          const label = menu.querySelector('li[data-command="2"] span')?.textContent;
          assert(label === '3', `${where}: a user command's label is shown as written: ${label}`);
        };

        // The template, drawn under the locale.
        box.render();
        const before = shown.length;
        collect('controls', box, `${HOSTED}, .skill-glyph`);
        assert(shown.length - before >= 15, `the controls drew too little: ${shown.length - before}`);
        // Bound after the render, which reads the thread for its placeholder.
        box._messageThread = { getContextItems: () => [new SkillStandIn()] };

        // The commands menu.
        await box._openCommandsMenu();
        const commands = box._commandsMenu;
        try {
          assert(!!commands, 'the commands menu did not open');
          shown.push(['commands menu label', commands.getAttribute('aria-label') || '']);
          assert(!!commands.querySelector('li[data-command="1"]'), 'the commands menu drew no built-in row');
          collect('commands menu', commands, data);
          userTextAsGiven(commands, 'commands menu');
        } finally {
          box._closeCommandsMenu();
        }

        // The skill menu, empty and with a skill.
        for (const list of [[], [{ name: '5', description: '6' }]]) {
          skills = list;
          await box._openSkillMenu();
          const menu = box._skillMenu;
          const where = `skill menu (${list.length} skills)`;
          try {
            assert(!!menu, `${where} did not open`);
            shown.push([`${where} label`, menu.getAttribute('aria-label') || '']);
            collect(where, menu, data);
            if (list.length) {
              const desc = menu.querySelector('.skill-mention-item .menu-item-desc')?.textContent;
              assert(desc === '6', `${where}: a skill's description is shown as written: ${desc}`);
            }
          } finally {
            box._closeSkillMenu();
          }
        }

        // The actions sheet, every section (skills present, so both lists draw).
        await box._openActionsSheet();
        const sheet = box._actionsSheet;
        try {
          assert(!!sheet, 'the actions sheet did not open');
          assert(sheet.querySelectorAll('details').length === 2, 'the actions sheet drew fewer than two sections');
          shown.push(['actions sheet label', sheet.getAttribute('aria-label') || '']);
          collect('actions sheet', sheet, data);
          userTextAsGiven(sheet, 'actions sheet');
        } finally {
          box._closeActionsSheet();
        }

        const raw = shown.filter(([, s]) => !isPseudoLocalized(s));
        assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
      }, { [STAND_IN_EXTENSION]: ['Stand-in command'] });
    } finally {
      handler.init = realInit;
      handler.getCommands = realGetCommands;
      box._messageThread = realThread;
      container.remove();
    }
  });

  return { passed, failed, errors };
}
