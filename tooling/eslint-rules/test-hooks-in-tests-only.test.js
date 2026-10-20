//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Cases for juggler/test-hooks-in-tests-only. Run by `make lint-js`; throws
 * (exit 1) on the first case that disagrees. Which files the rule applies to is
 * the config's business (tooling/eslint.config.js); every case here is a file
 * it applies to.
 */

import { log } from 'node:console';
import { RuleTester } from 'eslint';
import rule from './test-hooks-in-tests-only.js';

const tester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

const imported = { messageId: 'imported' };
const member = { messageId: 'member' };

tester.run('test-hooks-in-tests-only', rule, {
  valid: [
    // Ordinary imports and members.
    "import { getUserPref } from './prefs.js';",
    "import { getUserPref as __alias } from './prefs.js';",
    "import * as prefs from './prefs.js'; prefs.getUserPref('x');",
    "export { getUserPref } from './prefs.js';",
    // A module declaring its own hooks.
    'export function __resetPrefsForTests() {}',
    'export const __attention = { setFocusedForTest(v) { return v; } };',
    'class Phase { __resetForTests() {} }',
    'let rebuildHoldForTests = null; rebuildHoldForTests = 1;',
    // A local export of a hook the module declares.
    'function __hookForTests() {} export { __hookForTests };',
    // `__` globals the page sets are not test hooks.
    'const token = window.__jugglerToken;',
    // Computed access is not a name.
    "obj['resetForTests']();",
  ],
  invalid: [
    { code: "import { __resetPrefsForTests } from './prefs.js';", errors: [imported] },
    { code: "import { __attention } from './attention-manager.js';", errors: [imported] },
    { code: "import { __setEscapeHostForTests as stand } from './escape.js';", errors: [imported] },
    { code: "export { __resetPrefsForTests } from './prefs.js';", errors: [imported] },
    { code: 'appPhase.__resetForTests();', errors: [member] },
    { code: 'wsService.__simulateDisconnectForTests();', errors: [member] },
    { code: 'attention.setFocusedForTest(true);', errors: [member] },
    { code: "import * as rail from './info-rail.js'; rail.__allowInfoRailInTests(true);", errors: [member] },
    { code: 'const f = box.resetForTests;', errors: [member] },
  ],
});

log('✓ test-hooks-in-tests-only: all cases agree');
