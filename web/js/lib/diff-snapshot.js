//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Everything it costs to draw a snapshot diff — the line diff of two whole files
 * and the syntax highlighting of both — as one pure function with no DOM, so the
 * same code runs in the diff worker (workers/diff-worker.js) and, where there is
 * no worker, on the page.
 */

import { computeDiff } from './diff-utils.js';
import { highlightCodeLines } from '../../sdk/lib/syntax-highlight.js';
import { languageForPath } from '../../sdk/lib/languages.js';

/** @typedef {import('./diff-types.js').DiffHunk} DiffHunk */
/** @typedef {import('./diff-types.js').DiffLine} DiffLine */

/**
 * Largest side of a diff that is syntax-highlighted. Both sides are tokenised
 * whole so a hunk sees the file around it, which is linear but not free; past
 * this the diff is drawn plain.
 */
const MAX_HIGHLIGHT_CHARS = 200_000;

/**
 * @typedef {object} SnapshotInput
 * @property {string} oldContent - The whole file before.
 * @property {string} newContent - The whole file after.
 * @property {string} filePath - The path, which chooses the grammar.
 * @property {number} startLineNumber - The number of the first line of both sides.
 * @property {number} contextLines - Unchanged lines around each change, already
 *   resolved from the preference (Infinity for the whole file).
 */

/**
 * @typedef {object} Snapshot
 * @property {DiffHunk[]|null} hunks - The hunks, each line carrying its `markup`,
 *   or null when the changed region is past the line diff's budget.
 * @property {number} added - Lines added.
 * @property {number} removed - Lines removed.
 */

/**
 * Tokenise one side whole, into per-line markup.
 *
 * Highlighting the whole side rather than the visible hunks is deliberate: a
 * hunk is a window into the middle of a file, and a line taken on its own
 * tokenises wrong — the inside of a block comment reads as code.
 * @param {string} text - The side.
 * @param {string} language - The grammar.
 * @returns {{source: string[], markup: string[]}|null} The lines and their
 *   markup, or null when the side is left plain.
 */
function highlightSide(text, language) {
  if (language === 'text' || text.length > MAX_HIGHLIGHT_CHARS) return null;
  return { source: text.split('\n'), markup: highlightCodeLines(text, language) };
}

/**
 * Diff two whole files and highlight the lines the diff draws.
 *
 * Each drawn line's markup is taken from its side's tokenised array at
 * `lineNum - startLineNumber`, the numbering `computeDiff` derives from
 * splitting these same two strings, and only when the source text at that index
 * is the line in hand: an index that had drifted would show the wrong line's
 * content and look like a diff bug rather than a highlighting one. A line with
 * no markup is drawn as its escaped text.
 *
 * Only the drawn lines carry markup, so what crosses back from a worker is the
 * size of the diff and not of the files.
 * @param {SnapshotInput} input - The two sides and how to draw them.
 * @returns {Snapshot} What to draw.
 */
export function buildSnapshot(input) {
  const { oldContent, newContent, filePath, startLineNumber, contextLines } = input;
  const hunks = computeDiff(oldContent, newContent, startLineNumber, contextLines);
  if (hunks === null) return { hunks: null, added: 0, removed: 0 };

  const language = languageForPath(filePath);
  const both = oldContent.length <= MAX_HIGHLIGHT_CHARS && newContent.length <= MAX_HIGHLIGHT_CHARS;
  const sides = both
    ? { old: highlightSide(oldContent, language), new: highlightSide(newContent, language) }
    : { old: null, new: null };

  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.type === 'add') added++;
      else if (line.type === 'remove') removed++;
      const side = line.type === 'add' ? sides.new : sides.old;
      if (!side) continue;
      const number = line.type === 'add' ? line.newLineNum : line.oldLineNum;
      const index = (number ?? 0) - startLineNumber;
      if (side.source[index] === line.content && side.markup[index] !== undefined) {
        line.markup = side.markup[index];
      }
    }
  }
  return { hunks, added, removed };
}
