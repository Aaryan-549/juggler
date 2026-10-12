//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The SDK a run_code program is described with, and the detail behind it.
 *
 * The SDK rides in run_code's tool description, which every request carries,
 * so it describes no tool: every tool a program may call is already in the
 * model's tool list, schema and all. It is one rule — call a tool by its name,
 * with the arguments it takes there — and the names of the offered tools the
 * rule does not cover. `describeTool(name)` gives a program any callable
 * tool's whole description and arguments at run time (describeProgramTool).
 *
 * Pure — tool definitions in, text out — so the text the model is shown is a
 * function of exactly the tools the thread offers, and nothing else.
 * @module context-items/code/render-sdk
 */

const RULE = '`await tools.<name>({...})` calls any tool in your tool list by its name, with the same arguments, '
  + 'and resolves to its result text or throws its error, which the program may catch.';

const DESCRIBE = '`await describeTool(name)` gives a tool\'s description and arguments; `describeTool()` lists them all.';

/**
 * A JSON-schema property's type, as JSDoc writes it.
 * @param {any} schema - The property schema
 * @returns {string} The JSDoc type
 */
function jsdocType(schema) {
  if (!schema || typeof schema !== 'object') return '*';
  if (Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.length <= 8) {
    return schema.enum.map((/** @type {unknown} */ v) => JSON.stringify(v)).join('|');
  }
  const t = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (t) {
    case 'string': return 'string';
    case 'number':
    case 'integer': return 'number';
    case 'boolean': return 'boolean';
    case 'array': return `${jsdocType(schema.items)}[]`;
    case 'object': return 'object';
    default: return '*';
  }
}

/**
 * A tool's arguments, required ones first as written, optional ones marked.
 * @param {{input_schema?: any}} def - The tool's definition
 * @returns {Array<{key: string, schema: any, required: boolean}>} Its arguments
 */
function argumentsOf(def) {
  const props = def.input_schema?.properties && typeof def.input_schema.properties === 'object'
    ? def.input_schema.properties
    : {};
  const required = new Set(Array.isArray(def.input_schema?.required) ? def.input_schema.required : []);
  return Object.entries(props).map(([key, schema]) => ({ key, schema, required: required.has(key) }));
}

/**
 * One tool, whole: its full description and every argument, as JSDoc. What
 * `describeTool(name)` returns to a program.
 * @param {{name: string, description?: string, input_schema?: any}} def - The tool's definition
 * @returns {string} Its JSDoc block and call
 */
export function describeProgramTool(def) {
  const description = typeof def.description === 'string' && def.description.trim() ? def.description.trim() : def.name;
  const lines = ['/**', ...description.split('\n').map((l) => (l ? ` * ${l}` : ' *')), ' * @param {object} args'];
  for (const { key, schema, required } of argumentsOf(def)) {
    const name = required ? `args.${key}` : `[args.${key}]`;
    const desc = String(/** @type {any} */ (schema)?.description ?? '').replace(/\s+/g, ' ').trim();
    lines.push(` * @param {${jsdocType(schema)}} ${name}${desc ? ` - ${desc}` : ''}`);
  }
  lines.push(' * @returns {Promise<string>} The tool\'s result text', ' */', `tools.${def.name}(args)`);
  return lines.join('\n');
}

/**
 * A tool name without the `mcp__<server>__` prefix a provider may list it under
 * (Claude Code lists Juggler's tools as `mcp__juggler__<name>`), for looking a
 * tool up by the name a program read in the model's tool list when the name as
 * given is not a tool. The invoker admits calls by the same rule.
 * @param {string} name - A tool name as a program gave it
 * @returns {string} The name after the prefix, or the name unchanged
 */
export function toolOwnName(name) {
  const match = /^mcp__.+?__(.+)$/.exec(name);
  return match ? /** @type {string} */ (match[1]) : name;
}

/**
 * Render the SDK for a program tool: the rule for calling the tools a program
 * may call, and the names of the offered tools it may not. The callable tools
 * are not listed — they are in the model's tool list already — so their number
 * never changes the text.
 * @param {Array<{name: string}>} callable - The offered tools a program may call
 * @param {Array<{name: string}>} [excluded] - The offered tools it may not, the program tool aside
 * @returns {string} The SDK text
 */
export function renderProgramSdk(callable, excluded = []) {
  if (!Array.isArray(callable) || callable.length === 0) {
    return 'No tools are callable from a program in this thread; use fs, grep and glob only.';
  }
  const names = (Array.isArray(excluded) ? excluded : []).map((d) => d.name);
  const not = names.length > 0 ? ` Not callable from a program: ${names.join(', ')}.` : '';
  return `${RULE}${not} ${DESCRIBE}`;
}
