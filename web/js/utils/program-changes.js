//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The change report the model is sent after a program tool's result.
 *
 * The worker builds it in the wire projection (`programChangeReport`,
 * cmd/juggler/worker/program_changes.go) from the call record the engine keeps
 * on the program's tool-action (`displayData.nestedCalls`), so the model is
 * told what changed however the program ended — including a cancel or an engine
 * death, where the program never returns anything. This is its mirror, byte for
 * byte, for the numbers the UI works out itself (`llmTextForItem`).
 * @module utils/program-changes
 */

/** Longest list of changes listed before the rest are counted. */
const MAX_LINES = 50;

/**
 * The changes a program tool made, as appended to its tool_result: every
 * call that changes things, noted when it failed or never finished. Identical
 * lines (a file edited twice) are listed once, where the first fell, with a
 * count. Reads are never listed.
 * @param {any} displayData - The program's displayData, plain or a Y.Map
 * @returns {string} The report, or '' when the record holds no change
 */
export function programChangeReport(displayData) {
  const data = displayData?.toJSON ? displayData.toJSON() : displayData;
  const calls = Array.isArray(data?.nestedCalls) ? data.nestedCalls : [];
  /** Each distinct line, by its text, with how many calls it stands for. */
  /** @type {Map<string, number>} */
  const lines = new Map();
  for (const c of calls) {
    if (typeof c?.effect !== 'string' || c.effect === '') continue;
    const note = c.status === 'ok' ? '' : c.status === 'error' ? ' (failed)' : ' (interrupted)';
    const line = `${c.effect}${note}`;
    lines.set(line, (lines.get(line) ?? 0) + 1);
  }
  const all = [...lines];
  const kept = all.slice(0, MAX_LINES);
  // Past the cap, the rest are counted in changes, not lines.
  const omitted = Number.isInteger(data?.omittedEffects) ? data.omittedEffects : 0;
  const extra = all.slice(MAX_LINES).reduce((n, [, count]) => n + count, omitted);
  if (kept.length === 0 && extra === 0) return '';
  let text = '\n\nChanges the program made:'
    + kept.map(([line, count]) => `\n- ${line}${count > 1 ? ` (×${count})` : ''}`).join('');
  if (extra > 0) text += `\n…and ${extra} more`;
  return text;
}
