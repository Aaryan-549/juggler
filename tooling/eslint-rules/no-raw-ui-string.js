//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * ESLint rule: user-visible text goes through t() from `juggler/i18n`.
 *
 * Two checks.
 *
 * **Raw strings.** A string or template literal
 * containing letters that flows into a place the user reads it:
 *   - assignment to `textContent`, `innerText`, `title`, `placeholder`,
 *     `ariaLabel`, `label` or `alt`;
 *   - `setAttribute('aria-label'|'aria-description'|'title'|'placeholder'|'alt', …)`;
 *   - the text, or a title/placeholder/aria-label/alt attribute, inside markup
 *     assigned to `innerHTML`/`outerHTML`, passed to `insertAdjacentHTML`, or
 *     written as an `html` tagged template;
 *   - the third argument of a `createElement(tag, className, text)` helper;
 *   - the message of `showAlert` / `showConfirm` / `showPrompt`;
 *   - string arguments of `append`/`prepend`/`replaceChildren`/`before`/`after`;
 *   - an object property named `label`, `title`, `tooltip`, `placeholder`,
 *     `message` or `text` — menu items and option tables. Tables keep their
 *     English wrapped in `markForTranslation()`. `description` is deliberately
 *     not on the list: most of them are tool and schema text the model reads;
 *   - `label`, `text`, `title`, `tooltip`, `detail` or `summary` in the object a
 *     `getStatusUI()` method returns.
 * Both arms of `?:`, both sides of `||`/`??`/`&&`, and every part of a `+` are
 * followed. Handled: wrapped in `t()`, in `markForTranslation()` (English held
 * for a later `t()`), or in `markUntranslated()` for text that is deliberately
 * English; or `// i18n-ignore: <reason>` on the line or the line
 * above. It is a heuristic by design — a miss shows up as plain English under
 * the en-XA pseudo-locale, and a false positive costs one annotation.
 *
 * **Module scope** (always on). A `t()` — imported from an i18n module under
 * whatever local name, or created by its `translator()` — evaluated at module
 * scope or in a static class
 * field runs once, at import, and is frozen in whatever language was active
 * then. Keep English in such places, wrapped in `markForTranslation()`, and call
 * `t()` where the text is rendered.
 * @type {import('eslint').Rule.RuleModule}
 */

const TEXT_PROPERTIES = new Set(['textContent', 'innerText', 'title', 'placeholder', 'ariaLabel', 'label', 'alt']);
const TEXT_ATTRIBUTES = new Set(['aria-label', 'aria-description', 'title', 'placeholder', 'alt']);
const HTML_PROPERTIES = new Set(['innerHTML', 'outerHTML']);
const DIALOG_FUNCTIONS = new Set(['showAlert', 'showConfirm', 'showPrompt']);
const STATUS_KEYS = new Set(['label', 'text', 'title', 'tooltip', 'detail', 'summary']);
const OBJECT_TEXT_KEYS = new Set(['label', 'title', 'tooltip', 'placeholder', 'message', 'text']);
const NODE_TEXT_METHODS = new Set(['append', 'prepend', 'replaceChildren', 'before', 'after']);
const I18N_SOURCES = [/(^|\/)i18n\.js$/, /^juggler\/i18n$/];
const HANDLED_FUNCTIONS = new Set(['t', 'markUntranslated', 'markForTranslation']);

/** Placeholder for an interpolated expression inside joined template text. */
const HOLE = '\u0000';

const LETTER = /\p{L}/u;

/** @typedef {import('estree').Node & {parent?: ASTNode, [key: string]: unknown}} ASTNode */

/**
 * @param {string} text - Literal text, interpolations marked by HOLE.
 * @returns {boolean} Whether the text holds anything a translator would translate.
 */
function hasWords(text) {
  return LETTER.test(text.split(HOLE).join(''));
}

/**
 * The visible words of an HTML fragment: its text nodes and its text-bearing
 * attributes. Interpolations are holes; whole tags (attributes included) are
 * dropped after their text-bearing attributes have been pulled out.
 * @param {string} markup - An HTML fragment, interpolations marked by HOLE.
 * @returns {string} The text a user would read.
 */
function visibleHtmlText(markup) {
  const attrs = [];
  const attrRe = /\b(?:title|placeholder|aria-label|aria-description|alt)\s*=\s*(["'])(.*?)\1/gis;
  for (const m of markup.matchAll(attrRe)) attrs.push(m[2]);
  const text = markup
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z]+;|&#x?[0-9a-f]+;/gi, ' ');
  return [text, ...attrs].join(' ');
}

export default {
  meta: {
    type: 'problem',
    docs: { description: 'User-visible text goes through t() from juggler/i18n' },
    schema: [],
    messages: {
      raw: "User-visible text '{{text}}' is not translatable: wrap it in t() from juggler/i18n "
        + "(markUntranslated() if it must stay English, or '// i18n-ignore: <reason>').",
      moduleScope: 't() at module scope runs once, at import, and never follows the UI language. '
        + 'Keep the English here (wrapped in markForTranslation()) and call t() where it is rendered.',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;

    /** Local names of t() imported from i18n or created by its translator(). */
    const tNames = new Set();
    /** Lines an `i18n-ignore: <reason>` comment covers (its own and the next). */
    const ignoredLines = new Set();
    for (const comment of sourceCode.getAllComments()) {
      if (/^\s*i18n-ignore:\s*\S/.test(comment.value)) {
        ignoredLines.add(comment.loc.end.line);
        ignoredLines.add(comment.loc.end.line + 1);
      }
    }

    /**
     * @param {ASTNode} node - Where to report.
     * @param {string} text - The offending text, for the message.
     */
    const report = (node, text) => {
      if (ignoredLines.has(node.loc.start.line)) return;
      const clean = text.split(HOLE).join('…').replace(/\s+/g, ' ').trim();
      context.report({
        node,
        messageId: 'raw',
        data: { text: clean.length > 50 ? `${clean.slice(0, 47)}...` : clean },
      });
    };

    /**
     * Whether a call is a translation (or a deliberate English mark).
     * @param {ASTNode} node - The node in question.
     * @returns {boolean} True for t()/markUntranslated().
     */
    const isHandledCall = (node) => {
      const callee = node.callee;
      const name = callee.type === 'Identifier' ? callee.name
        : callee.type === 'MemberExpression' && !callee.computed ? callee.property.name : '';
      return HANDLED_FUNCTIONS.has(name) || tNames.has(name);
    };

    /**
     * Report every raw literal an expression's value can come from.
     * @param {ASTNode} node - The node in question.
     * @param {(text: string) => string} [visible] - Maps literal text to what the user reads.
     */
    const checkValue = (node, visible = (s) => s) => {
      if (!node) return;
      switch (node.type) {
        case 'Literal':
          if (typeof node.value === 'string' && hasWords(visible(node.value))) report(node, node.value);
          return;
        case 'TemplateLiteral': {
          const joined = node.quasis.map((q) => q.value.cooked ?? q.value.raw).join(HOLE);
          if (hasWords(visible(joined))) report(node, joined);
          return;
        }
        case 'TaggedTemplateExpression':
          return;
        case 'ConditionalExpression':
          checkValue(node.consequent, visible);
          checkValue(node.alternate, visible);
          return;
        case 'LogicalExpression':
          checkValue(node.left, visible);
          checkValue(node.right, visible);
          return;
        case 'BinaryExpression': {
          // A concatenation is judged as one string, so markup split across
          // literals still reads as markup and a sentence as one sentence.
          if (node.operator !== '+') return;
          const joined = flattenConcat(node);
          if (hasWords(visible(joined))) report(node, joined);
          return;
        }
        default:
          return;
      }
    };

    /**
     * The text of a `+` chain of literals and templates, holes for anything
     * else (a t() call included).
     * @param {ASTNode} node - The node in question.
     * @returns {string} The joined text.
     */
    const flattenConcat = (node) => {
      if (node.type === 'BinaryExpression' && node.operator === '+') {
        return `${flattenConcat(node.left)}${flattenConcat(node.right)}`;
      }
      if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
      if (node.type === 'TemplateLiteral') return node.quasis.map((q) => q.value.cooked ?? q.value.raw).join(HOLE);
      return HOLE;
    };

    /**
     * Report the visible words of markup an expression produces.
     * @param {ASTNode} node - The markup expression.
     */
    const checkHtml = (node) => {
      if (node?.type === 'CallExpression' && isHandledCall(node)) return;
      checkValue(node, visibleHtmlText);
    };

    /**
     * Whether a node is evaluated when the module loads: outside every function,
     * or in a static class field / static block.
     * @param {ASTNode} node - The node in question.
     * @returns {boolean} True at module scope.
     */
    const atModuleScope = (node) => {
      for (let p = node.parent; p; p = p.parent) {
        if (p.type === 'FunctionDeclaration' || p.type === 'FunctionExpression' || p.type === 'ArrowFunctionExpression') {
          return false;
        }
        if (p.type === 'StaticBlock') return true;
        if (p.type === 'PropertyDefinition') return !!p.static;
      }
      return true;
    };

    /**
     * The name a member expression's property is written as, or ''.
     * @param {ASTNode} node - The node in question.
     * @returns {string} The property name.
     */
    const propName = (node) => {
      if (node?.type !== 'MemberExpression') return '';
      if (!node.computed && node.property.type === 'Identifier') return node.property.name;
      if (node.computed && node.property.type === 'Literal') return String(node.property.value);
      return '';
    };

    /**
     * The function a call invokes, by name: `f(…)` or `x.f(…)`.
     * @param {ASTNode} node - The node in question.
     * @returns {string} The name, or ''.
     */
    const calleeName = (node) => {
      if (node.callee.type === 'Identifier') return node.callee.name;
      return propName(node.callee);
    };

    return {
      Program(node) {
        const translators = new Set();
        for (const stmt of node.body) {
          if (stmt.type !== 'ImportDeclaration' || !I18N_SOURCES.some((re) => re.test(String(stmt.source.value)))) continue;
          for (const spec of stmt.specifiers) {
            if (spec.type !== 'ImportSpecifier') continue;
            if (spec.imported.name === 't') tNames.add(spec.local.name);
            if (spec.imported.name === 'translator') translators.add(spec.local.name);
          }
        }
        // Match scripts/i18n extraction: collect translator-created names before
        // checking calls, regardless of import or declaration order.
        const collect = (/** @type {ASTNode} */ child) => {
          if (!child) return;
          if (child.type === 'VariableDeclarator' && child.id.type === 'Identifier'
            && child.init?.type === 'CallExpression' && child.init.callee.type === 'Identifier'
            && translators.has(child.init.callee.name)) {
            tNames.add(child.id.name);
          }
          for (const key of sourceCode.visitorKeys[child.type] ?? []) {
            const value = /** @type {ASTNode | ASTNode[]} */ (child[key]);
            if (Array.isArray(value)) value.forEach(collect);
            else collect(value);
          }
        };
        if (translators.size > 0) collect(node);
      },

      CallExpression(node) {
        if (node.callee.type === 'Identifier' && tNames.has(node.callee.name) && atModuleScope(node)) {
          context.report({ node, messageId: 'moduleScope' });
        }
        if (isHandledCall(node)) return;
        const name = calleeName(node);
        const args = node.arguments;
        if (name === 'setAttribute' && args.length >= 2) {
          const attr = args[0];
          if (attr.type === 'Literal' && TEXT_ATTRIBUTES.has(String(attr.value).toLowerCase())) checkValue(args[1]);
        } else if (name === 'insertAdjacentHTML' && args.length >= 2) {
          checkHtml(args[1]);
        } else if (name === 'createElement' && args.length >= 3) {
          checkValue(args[2]);
        } else if (NODE_TEXT_METHODS.has(name) && node.callee.type === 'MemberExpression') {
          for (const arg of args) {
            if (arg.type === 'Literal' || arg.type === 'TemplateLiteral') checkValue(arg);
          }
        } else if (DIALOG_FUNCTIONS.has(name)) {
          checkValue(args[0]);
          if (args[1] && (args[1].type === 'Literal' || args[1].type === 'TemplateLiteral')) checkValue(args[1]);
        }
      },

      AssignmentExpression(node) {
        if (node.operator !== '=' && node.operator !== '+=') return;
        const prop = propName(node.left);
        if (TEXT_PROPERTIES.has(prop)) checkValue(node.right);
        else if (HTML_PROPERTIES.has(prop)) checkHtml(node.right);
      },

      TaggedTemplateExpression(node) {
        if (node.tag.type === 'Identifier' && node.tag.name === 'html') {
          const joined = node.quasi.quasis.map((q) => q.value.cooked ?? q.value.raw).join(HOLE);
          if (hasWords(visibleHtmlText(joined))) report(node, joined);
        }
      },

      Property(node) {
        if (node.parent?.type !== 'ObjectExpression' || node.computed || node.kind !== 'init') return;
        const name = node.key.type === 'Identifier' ? node.key.name : node.key.value;
        if (OBJECT_TEXT_KEYS.has(name)) checkValue(node.value);
      },

      ReturnStatement(node) {
        if (node.argument?.type !== 'ObjectExpression') return;
        // The nearest enclosing function must be a getStatusUI method.
        let fn = node.parent;
        while (fn && !['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(fn.type)) {
          fn = fn.parent;
        }
        const owner = fn?.parent;
        const key = owner && (owner.type === 'MethodDefinition' || owner.type === 'Property') ? owner.key : null;
        if (!key || (key.name ?? key.value) !== 'getStatusUI') return;
        const visit = (/** @type {ASTNode} */ obj) => {
          for (const p of obj.properties) {
            if (p.type !== 'Property') continue;
            const name = p.key.name ?? p.key.value;
            if (p.value.type === 'ObjectExpression') visit(p.value);
            // Properties named in OBJECT_TEXT_KEYS are checked wherever they are.
            else if (STATUS_KEYS.has(name) && !OBJECT_TEXT_KEYS.has(name)) checkValue(p.value);
          }
        };
        visit(node.argument);
      },
    };
  },
};
