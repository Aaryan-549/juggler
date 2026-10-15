//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Model-chip thinking-pill render-rule unit tests.
 *
 * `ModelChip.thinkingChipHTML` must always show the EFFECTIVE level for a
 * selected thinking-capable model: an explicit advertised level ⇒ solid chip;
 * no explicit level ⇒ hollow `.default` variant showing `defaultThinkingLevel`
 * (or "def" when the model declares none); non-thinking models ⇒ no chip at
 * all. Tested on a real (registered) `<model-chip>` created via
 * `document.createElement` but never appended, with `providers` and `config`
 * set directly — the chip is controlled, so that is its whole input.
 * @module unit-tests/thinking-chip-test
 */

import { assert } from '../utilities/test-helpers.js';
import '../../js/components/model-picker/model-chip.js';
import keyShortcutManager from '../../js/services/key-shortcut-manager.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';
import { underPseudoLocale } from '../utilities/pseudo-locale.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/**
 * Build a detached model-chip with one provider/model set on it.
 * @param {object} opts - Scenario knobs.
 * @param {string[]} [opts.levels] - `thinkingLevels` the model advertises, as
 *   native level strings shown verbatim (omit for a non-thinking model).
 * @param {string} [opts.defaultLevel] - The model's `defaultThinkingLevel`.
 * @param {string} [opts.thinking] - Explicit level in the current config.
 * @returns {any} The (never-connected) chip element.
 */
function makeChip({ levels, defaultLevel, thinking }) {
  const el = /** @type {any} */ (document.createElement('model-chip'));
  /** @type {any} */
  const modelEntry = { id: 'model-x', contextWindow: 200000 };
  if (levels) modelEntry.thinkingLevels = levels;
  if (defaultLevel) modelEntry.defaultThinkingLevel = defaultLevel;
  el.update({
    providers: [{ name: 'prov', displayName: 'Prov', available: true, modelsWithContext: [modelEntry] }],
    config: thinking
      ? { provider: 'prov', model: 'model-x', thinking }
      : { provider: 'prov', model: 'model-x' },
  });
  return el;
}

/**
 * Parse chip HTML into an element for class/text assertions.
 * @param {string} html - The `thinkingChipHTML()` return value.
 * @returns {Element|null} The chip element, or null for empty HTML.
 */
function chipOf(html) {
  if (!html) return null;
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  return tmp.firstElementChild;
}

/**
 * @param {object} _ctx - Test context (unused).
 * @returns {Promise<TestResult>} Aggregated results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label - Test label.
   * @param {() => (void | Promise<void>)} fn - Test body.
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

  await run('explicit advertised level renders a solid chip', () => {
    const el = makeChip({ levels: ['low', 'medium', 'high'], defaultLevel: 'high', thinking: 'medium' });
    const chip = chipOf(el.thinkingChipHTML());
    assert(chip !== null, 'a chip must render for an explicit level');
    assert(chip.classList.contains('thinking-chip') && !chip.classList.contains('default'),
      `explicit level ⇒ solid (no .default) — got class "${chip.className}"`);
    assert(chip.textContent === 'medium', `the native level is shown verbatim ("medium"), got "${chip.textContent}"`);
    assert((chip.getAttribute('title') || '').includes('Thinking: medium'),
      `title names the explicit level — got "${chip.getAttribute('title')}"`);
  });

  await run('no explicit level renders the hollow .default variant with the model default', () => {
    const el = makeChip({ levels: ['low', 'high'], defaultLevel: 'high' });
    const chip = chipOf(el.thinkingChipHTML());
    assert(chip !== null, 'a chip must render for a thinking model with a default level');
    assert(chip.classList.contains('thinking-chip') && chip.classList.contains('default'),
      `default level ⇒ hollow .default variant — got class "${chip.className}"`);
    assert(chip.textContent === 'high', `the model default is shown, got "${chip.textContent}"`);
    assert((chip.getAttribute('title') || '').includes('(default)'),
      `title marks the level as the default — got "${chip.getAttribute('title')}"`);
  });

  await run('no defaultThinkingLevel and no explicit level renders hollow def', () => {
    const el = makeChip({ levels: ['low', 'high'] });
    const chip = chipOf(el.thinkingChipHTML());
    assert(chip !== null, 'a thinking-capable model must always render a chip');
    assert(chip.classList.contains('thinking-chip') && chip.classList.contains('default'),
      `undeclared default ⇒ hollow .default variant — got class "${chip.className}"`);
    assert(chip.textContent === 'def', `the fallback label is "def", got "${chip.textContent}"`);
    assert((chip.getAttribute('title') || '').includes('Thinking: default'),
      `title names the default selection — got "${chip.getAttribute('title')}"`);
  });

  await run('non-thinking model ⇒ no chip, even with a stale config level', () => {
    const el = makeChip({ thinking: 'high' });
    assert(el.thinkingChipHTML() === '', 'a model without thinkingLevels must never grow a chip');
  });

  await run('a native level string is shown verbatim on the chip', () => {
    // codex-max advertises a native "xhigh" level: the chip shows it as-is.
    const el = makeChip({ levels: ['high', 'xhigh'], thinking: 'xhigh' });
    const chip = chipOf(el.thinkingChipHTML());
    assert(chip !== null && !chip.classList.contains('default'), 'an explicit advertised level ⇒ solid chip');
    assert(chip.textContent === 'xhigh', `the native level is shown, got "${chip.textContent}"`);
  });

  await run('a stale explicit level the model no longer advertises falls back to the hollow default', () => {
    const el = makeChip({ levels: ['low', 'high'], defaultLevel: 'high', thinking: 'medium' });
    const chip = chipOf(el.thinkingChipHTML());
    assert(chip !== null && chip.classList.contains('default'),
      'an unadvertised stored level means "default", so the chip goes hollow');
    assert(chip.textContent === 'high', `the fallback shows the model default, got "${chip.textContent}"`);
  });

  await run('an unchanged update preserves the thinking chip node', async () => {
    const el = makeChip({ levels: ['low', 'medium', 'high'], thinking: 'medium' });
    const button = el.button;
    const chip = el.querySelector('.thinking-chip');
    assert(button && chip, 'the rendered model button must contain a thinking chip');

    /** @type {MutationRecord[]} */
    const mutations = [];
    const observer = new MutationObserver(records => mutations.push(...records));
    observer.observe(button, { childList: true, subtree: true });
    el.update({ providers: el.providers, config: el.config });
    await Promise.resolve();
    observer.disconnect();

    assert(el.button === button, 'an unchanged update must preserve the model button');
    assert(el.querySelector('.thinking-chip') === chip,
      'an unchanged update must preserve the thinking chip');
    assert(mutations.length === 0,
      `an unchanged update must not mutate the button subtree — got ${mutations.length} mutations`);
  });

  // Every state the chip draws, under en-XA. Model names, level strings and tier
  // names are data (digits here); the chip's own words are not. The cycle-key
  // hint is stubbed to a digit — a real key cap carries ASCII letters.
  await run('en-XA: every chip state is translated', async () => {
    const ownFormatBinding = Object.prototype.hasOwnProperty.call(keyShortcutManager, 'formatBinding');
    const originalFormatBinding = keyShortcutManager.formatBinding;
    /** @type {any} */
    let el = null;
    try {
      await underPseudoLocale('thinking-chip-test', () => {
        /** @type {string[]} */
        const shown = [];
        /**
         * @param {string} where - The state being drawn.
         * @param {string|null|undefined} s - What it showed.
         */
        const see = (where, s) => {
          assert(!!s, `${where}: nothing drawn`);
          shown.push(/** @type {string} */ (s));
        };
        const chipEl = () => /** @type {HTMLElement|null} */ (el.querySelector('.thinking-chip'));

        // Empty: the default placeholder and button title.
        el = /** @type {any} */ (document.createElement('model-chip'));
        el.render();
        see('placeholder', el.querySelector('.model-name')?.textContent);
        see('button title', el.button?.getAttribute('title'));

        // Connection faults replace the model label.
        for (const state of ['error', 'disconnected', 'connecting']) {
          el.connectionState = state;
          see(`connection ${state}`, el.querySelector('.model-name')?.textContent);
        }
        el.connectionState = null;

        /** @type {any} */
        const entry = { id: '7', displayName: '7', thinkingLevels: ['1', '2'], defaultThinkingLevel: '2',
          serviceTiers: [{ id: '5', name: '5', description: '6' }] };
        const providers = [{ name: '4', displayName: '4', available: true, modelsWithContext: [entry] }];

        // Explicit level, with and without a cycle-key hint.
        keyShortcutManager.formatBinding = () => '9';
        el.update({ providers, config: { provider: '4', model: '7', thinking: '1' } });
        see('explicit, key hint', chipEl()?.getAttribute('title'));
        keyShortcutManager.formatBinding = () => '';
        el.update({ providers, config: { provider: '4', model: '7', thinking: '2' } });
        see('explicit, no key', chipEl()?.getAttribute('title'));

        // Declared default (hollow), with and without the hint.
        el.update({ providers, config: { provider: '4', model: '7' } });
        see('declared default, no key', chipEl()?.getAttribute('title'));
        keyShortcutManager.formatBinding = () => '9';
        el.update({ providers: [{ ...providers[0], modelsWithContext: [{ ...entry, defaultThinkingLevel: '1' }] }],
          config: { provider: '4', model: '7' } });
        see('declared default, key hint', chipEl()?.getAttribute('title'));

        // No declared default: the "def" pill and its title.
        el.update({ providers: [{ ...providers[0], modelsWithContext: [{ ...entry, defaultThinkingLevel: '' }] }],
          config: { provider: '4', model: '7' } });
        see('undeclared default, key hint', chipEl()?.getAttribute('title'));
        see('undeclared default pill', chipEl()?.textContent);
        keyShortcutManager.formatBinding = () => '';
        el.render();
        see('undeclared default, no key', chipEl()?.getAttribute('title'));

        // Service tier: the provider's name is data, the title joins it to its description.
        el.update({ providers, config: { provider: '4', model: '7', thinking: '1', serviceTier: '5' } });
        see('service tier title', el.querySelector('.service-tier-chip')?.getAttribute('title'));

        // The mini thinking popover's accessible name.
        document.body.appendChild(el);
        assert(el.openMini(), 'the mini popover must open for a thinking model');
        see('mini popover aria-label', document.querySelector('.thinking-mini')?.getAttribute('aria-label'));
        el.closeMini();

        const raw = shown.filter((s) => !isPseudoLocalized(s));
        assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
      });
    } finally {
      if (ownFormatBinding) keyShortcutManager.formatBinding = originalFormatBinding;
      else delete /** @type {any} */ (keyShortcutManager).formatBinding;
      el?.closeMini();
      el?.remove();
    }
  });

  return { passed, failed, errors };
}
