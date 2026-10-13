//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Cases for juggler/no-raw-ui-string. Run by `make lint-js`; throws (exit 1) on
 * the first case that disagrees.
 */

import { log } from 'node:console';
import { RuleTester } from 'eslint';
import rule from './no-raw-ui-string.js';

const tester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

const IMPORT = "import { t, markUntranslated, markForTranslation } from '../sdk/lib/i18n.js';\n";

/**
 * @param {string} code - Statements for the function body.
 * @returns {string} The code inside a function, with the i18n import.
 */
const fn = (code) => `${IMPORT}function render(el, x, n) {\n${code}\n}`;

const raw = { messageId: 'raw' };
const moduleScope = { messageId: 'moduleScope' };

tester.run('no-raw-ui-string', rule, {
  valid: [
    // Wrapped, marked, or carrying no words.
    fn("el.textContent = t('Close');"),
    fn("el.textContent = markUntranslated('read_file');"),
    fn("el.title = t('{n} files', { n });"),
    fn("el.textContent = '×';"),
    fn("el.textContent = '…';"),
    fn("el.textContent = '';"),
    fn('el.textContent = `${n}`;'),
    fn("el.textContent = `${n} · ${x}`;"),
    fn('el.textContent = x;'),
    fn('el.textContent = x.name;'),
    // Not a text sink.
    fn("el.className = 'provider-name';"),
    fn("el.id = 'appearance-theme-select';"),
    fn("el.setAttribute('data-kind', 'tool');"),
    fn("el.setAttribute('aria-hidden', 'true');"),
    fn("document.createElement('div');"),
    fn("const cls = 'Close';"),
    // innerHTML with no visible words, or only translated ones.
    fn("el.innerHTML = '';"),
    fn('el.innerHTML = `<span class="icon">${x}</span>`;'),
    fn("el.innerHTML = `<b>${t('Close')}</b> <i>${n}</i>`;"),
    fn('el.innerHTML = `<span title="${t(\'Close\')}">&times;</span>`;'),
    // Escape hatch, with a reason, on the line or the line before.
    fn("// i18n-ignore: a keyboard key name\nel.textContent = 'Esc';"),
    fn("el.textContent = 'Esc'; // i18n-ignore: a keyboard key name"),
    // Module-level tables hold English, marked for extraction.
    `${IMPORT}const OPTIONS = [{ label: markForTranslation('System') }];`,
    // t() runs at render time inside functions, methods and instance fields.
    `${IMPORT}export function f() { return t('Close'); }`,
    `${IMPORT}const f = () => t('Close');`,
    `${IMPORT}class A { label = t('Close'); m() { return t('Open'); } }`,
    fn("el.append(x, ' ');"),
    fn("const item = { label: t('Copy'), id: 'copy' };"),
    `${IMPORT}const TOOL = { name: 'read', label: markUntranslated('read_file'), description: 'Reads a file.' };`,
    fn("const req = { method: 'PUT', type: 'text' };"),
    // A t that is not the i18n one is none of this rule's business.
    "import { t } from './other.js';\nconst x = t('Close');",
    // Translator factories are safe; their returned functions translate at render time.
    "import { translator } from 'juggler/i18n';\nconst tr = translator('@me/ext');",
    "import { translator } from 'juggler/i18n';\nconst tr = translator('@me/ext'); function render() { return tr('Close'); }",
    "import { translator as makeTranslator } from '../sdk/lib/i18n.js';\nconst translate = makeTranslator('@me/ext'); class A { label = translate('Close'); m() { return translate('Open'); } }",
    "import { translator } from './other.js';\nconst tr = translator('@me/ext'); const LABEL = tr('Close');",
    "const tr = translator('@me/ext'); const LABEL = tr('Close');",
    // rawStrings off (a pending file): only the module-scope check runs.
    { code: fn("el.textContent = 'Close';"), options: [{ rawStrings: false }] },
  ],
  invalid: [
    { code: fn("el.textContent = 'Close';"), errors: [raw] },
    { code: fn("el.innerText = 'Close';"), errors: [raw] },
    { code: fn("el.title = 'Close the panel';"), errors: [raw] },
    { code: fn("el.placeholder = 'Search files';"), errors: [raw] },
    { code: fn("el.ariaLabel = 'Close';"), errors: [raw] },
    { code: fn("el.textContent += ' more';"), errors: [raw] },
    { code: fn('el.textContent = `${n} files`;'), errors: [raw] },
    { code: fn("el.textContent = n === 1 ? 'file' : t('files');"), errors: [raw] },
    { code: fn("el.textContent = n + ' files';"), errors: [raw] },
    { code: fn("el.textContent = x || 'Untitled';"), errors: [raw] },
    { code: fn("el.setAttribute('aria-label', 'Close');"), errors: [raw] },
    { code: fn("el.setAttribute('title', `Open ${x}`);"), errors: [raw] },
    { code: fn("el.setAttribute('placeholder', 'Search');"), errors: [raw] },
    { code: fn("createElement('div', 'name', 'Theme');"), errors: [raw] },
    { code: fn("ui.createElement('div', 'name', 'Theme');"), errors: [raw] },
    { code: fn("showAlert('Saved');"), errors: [raw] },
    { code: fn("window.showConfirm('Delete this?');"), errors: [raw] },
    { code: fn("el.innerHTML = '<b>Close</b>';"), errors: [raw] },
    { code: fn('el.innerHTML = `<span class="x">${n} files</span>`;'), errors: [raw] },
    { code: fn('el.innerHTML = `<button title="Close">${x}</button>`;'), errors: [raw] },
    { code: fn("el.insertAdjacentHTML('beforeend', '<p>Done</p>');"), errors: [raw] },
    { code: fn('const h = html`<p>Done</p>`;'), errors: [raw] },
    {
      code: `${IMPORT}class Item { getStatusUI() { return { label: 'Running', icon: 'x' }; } }`,
      errors: [raw],
    },
    { code: fn("el.append('Done');"), errors: [raw] },
    { code: fn("el.prepend(icon, `Saved ${x}`);"), errors: [raw] },
    { code: `${IMPORT}const OPTIONS = [{ value: 'a', label: 'System' }];`, errors: [raw] },
    { code: fn("menu.push({ title: 'Copy path', tooltip: 'Copies it' });"), errors: [raw, raw] },
    { code: fn("return { placeholder: 'Search', message: n ? 'Found' : 'None' };"), errors: [raw, raw, raw] },
    // An i18n-ignore with no reason is not an escape hatch.
    { code: fn("// i18n-ignore:\nel.textContent = 'Close';"), errors: [raw] },
    // t() at module scope freezes in the language active at import.
    { code: `${IMPORT}const LABEL = t('Close');`, errors: [moduleScope] },
    { code: `${IMPORT}const OPTIONS = [{ label: t('System') }];`, errors: [moduleScope] },
    { code: `${IMPORT}export default { name: t('Thing') };`, errors: [moduleScope] },
    { code: `${IMPORT}class A { static LABEL = t('Close'); }`, errors: [moduleScope] },
    { code: "import { t as tr } from 'juggler/i18n';\nconst L = tr('Close');", errors: [moduleScope] },
    // Functions created by translator() have the same module-scope restriction.
    { code: "import { translator } from 'juggler/i18n';\nconst tr = translator('@me/ext'); const LABEL = tr('Close');", errors: [moduleScope] },
    { code: "import { translator as makeTranslator } from '../sdk/lib/i18n.js';\nconst translate = makeTranslator('@me/ext'); const OPTIONS = [{ label: translate('System') }];", errors: [moduleScope] },
    { code: "import { translator } from 'juggler/i18n';\nconst tr = translator('@me/ext'); class A { static LABEL = tr('Close'); static { tr('Open'); } }", errors: [moduleScope, moduleScope] },
    { code: "import { translator as makeTranslator } from 'juggler/i18n';\nconst tr = makeTranslator('@me/ext'); const LABEL = tr('Close');", options: [{ rawStrings: false }], errors: [moduleScope] },
    // Extraction collects imports and declarations before examining calls.
    { code: "const LABEL = tr('Close'); const tr = makeTranslator('@me/ext');\nimport { translator as makeTranslator } from 'juggler/i18n';", errors: [moduleScope] },
    // ...and is flagged in a pending file too.
    { code: `${IMPORT}const LABEL = t('Close');`, options: [{ rawStrings: false }], errors: [moduleScope] },
  ],
});

log('no-raw-ui-string: all cases pass');
