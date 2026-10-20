//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * ESLint rule: a test hook is reached only from a test.
 *
 * A module that needs a seam its tests can turn — reset a cache, pin a timeout,
 * stand in for a host — exports it under a name that says so:
 * - an export whose name begins `__` (`__resetPrefsForTests`, `__attention`), or
 * - a method whose name ends `ForTest(s)` / `InTest(s)`
 *   (`appPhase.__resetForTests()`, `__attention.setFocusedForTest()`).
 *
 * The hook ships, because the module does, but nothing in the app may call it:
 * a seam the app reaches is behaviour a user gets and no test describes. This
 * flags, in any file the config applies it to (everything but the tests):
 * - `import { __x } from '…'` and `export { __x } from '…'`;
 * - a member access `a.xForTests` / `a.xInTests`, called or not.
 *
 * A module declaring its own hook is untouched: declarations are not imports or
 * member accesses.
 * @type {import('eslint').Rule.RuleModule}
 */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'Test hooks (`__name` exports, `…ForTests` members) are for tests only' },
    schema: [],
    messages: {
      imported: "'{{name}}' is a test hook (an export named `__…`): only files under web/js-tests/ or an "
        + "extension's _tests/ may import it.",
      member: "'{{name}}' is a test hook (a member named `…ForTest(s)` / `…InTest(s)`): only tests may reach it.",
    },
  },
  create(context) {
    const MEMBER = /(?:For|In)Tests?$/;
    return {
      ImportSpecifier(node) {
        const name = node.imported.type === 'Identifier' ? node.imported.name : String(node.imported.value);
        if (name.startsWith('__')) context.report({ node, messageId: 'imported', data: { name } });
      },
      ExportSpecifier(node) {
        if (node.parent.type !== 'ExportNamedDeclaration' || !node.parent.source) return;
        const name = node.local.type === 'Identifier' ? node.local.name : String(node.local.value);
        if (name.startsWith('__')) context.report({ node, messageId: 'imported', data: { name } });
      },
      MemberExpression(node) {
        if (node.computed || node.property.type !== 'Identifier') return;
        const name = node.property.name;
        if (MEMBER.test(name)) context.report({ node: node.property, messageId: 'member', data: { name } });
      },
    };
  },
};
