//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Which offered tools a program may call: the tools a program tool
 * (`programSdk`) reaches through the tool invoker. Kept free of imports so the
 * viewer (the System Prompt panel renders the program SDK) can use the rule
 * without loading the executor that runs the calls (services/tool-invoker.js).
 * @module services/composable-tools
 */

/**
 * Whether a program may call this offered tool. Never a program tool itself,
 * one whose item declares `composable: false` (stamped onto its definitions by
 * generateToolDefinitions), or one that delegates to a sub-thread; and — when
 * its class is known — only one that runs through the action executor rather
 * than writing an item of its own.
 * @param {{name: string, programSdk?: boolean, composable?: boolean, delegatesToSubthread?: boolean}} def - The tool's definition
 * @param {any} [ItemClass] - The class providing it, when known
 * @returns {boolean} True when a program may call it
 */
export function isComposableTool(def, ItemClass) {
  if (!def?.name || def.programSdk || def.composable === false || def.delegatesToSubthread) return false;
  if (ItemClass === undefined) return true;
  if (!ItemClass) return false;
  if (ItemClass.MANIFEST?.workerManaged || ItemClass.MANIFEST?.composable === false) return false;
  return typeof ItemClass.isActionItem === 'function' ? !!ItemClass.isActionItem() : false;
}
