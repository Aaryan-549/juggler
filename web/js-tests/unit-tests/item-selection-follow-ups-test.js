//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * What an `item-selected` event does to the selection, and what it asks of the
 * columns afterwards.
 *
 * Two of the three follow-ups act through `requestAnimationFrame`, which never
 * fires in a test lane on macOS or Linux, so a test driving the tab sees the
 * row neither paged nor the approval engaged whatever the rules say. The rules
 * are decided by `selectionFollowUps` and the selection by `applySelection`,
 * and both are asserted here directly, on every platform.
 * @module unit-tests/item-selection-follow-ups-test
 */

import { assert } from '../utilities/test-helpers.js';
import { ColumnSelectionState, selectionFollowUps } from '../../js/utils/column-selection.js';

/**
 * A user's pointer selection in a paged viewport, entering another column:
 * every flag set the way that asks for all of it. Cases override one field.
 * @type {Parameters<typeof selectionFollowUps>[0]}
 */
const TAP = {
  origin: 'user',
  itemId: 'item-1',
  revealable: true,
  enteredAnotherColumn: true,
  keyboard: false,
  paged: true,
};

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name - Case name, reported on failure.
   * @param {() => void} fn - The case.
   */
  const check = (name, fn) => {
    try {
      fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  check('a user selection in another column takes the keyboard there', () => {
    const state = new ColumnSelectionState();
    state.selections = ['root-item'];
    const entered = state.applySelection(1, 'child-item', 'user');
    assert(entered, 'the keyboard target should have changed column');
    assert(state.activeColumnIndex === 1, `activeColumnIndex = ${state.activeColumnIndex}, want 1`);
    assert(state.selections.join() === 'root-item,child-item', `selections = ${state.selections}`);
    assert(state.lastManualInteractionTime > 0, 'a user selection is manual interaction');
  });

  check('an auto-selection leaves the keyboard and the interaction clock alone', () => {
    const state = new ColumnSelectionState();
    state.selections = ['root-item'];
    const entered = state.applySelection(1, 'arriving-tool', 'auto');
    assert(!entered, 'an auto-selection must not move the keyboard target');
    assert(state.activeColumnIndex === 0, `activeColumnIndex = ${state.activeColumnIndex}, want 0`);
    assert(state.selections[1] === 'arriving-tool', 'the auto-selection should still be applied');
    assert(state.lastManualInteractionTime === 0, 'an auto-selection is not manual interaction');
  });

  check('a selection within the active column does not change column', () => {
    const state = new ColumnSelectionState();
    state.applySelection(0, 'a', 'user');
    assert(!state.applySelection(0, 'b', 'user'), 'walking one column must not count as entering another');
  });

  check('a clear truncates the chain at its column', () => {
    const state = new ColumnSelectionState();
    state.selections = ['a', 'b', 'c'];
    state.applySelection(1, null, 'user');
    assert(state.selections.join() === 'a', `selections = ${state.selections}, want [a]`);
  });

  check('the row scrolls only for the user entering another column', () => {
    assert(selectionFollowUps(TAP).scrollColumns, 'clicking into another column should scroll to it');
    assert(!selectionFollowUps({ ...TAP, enteredAnotherColumn: false }).scrollColumns,
      'walking one column must keep the horizontal position');
    assert(!selectionFollowUps({ ...TAP, origin: 'auto' }).scrollColumns,
      'an auto-selection must never scroll the row');
  });

  check('a paged tap reveals the child column, and nothing else does', () => {
    assert(selectionFollowUps(TAP).revealDetails, 'a tap on a paged viewport should reveal');
    assert(!selectionFollowUps({ ...TAP, paged: false }).revealDetails, 'a wide viewport has the column in view');
    assert(!selectionFollowUps({ ...TAP, keyboard: true }).revealDetails, 'an arrow key must not page the row away');
    assert(!selectionFollowUps({ ...TAP, revealable: false }).revealDetails, 'prose and in-tile controls do not reveal');
    assert(!selectionFollowUps({ ...TAP, itemId: null }).revealDetails, 'a clear has nothing to reveal');
    assert(!selectionFollowUps({ ...TAP, origin: 'auto' }).revealDetails, 'an auto-selection must not page the row');
  });

  check('only an auto-selection of an item engages its approval', () => {
    assert(selectionFollowUps({ ...TAP, origin: 'auto' }).engageApproval, 'Rule 16: an auto-selected approval engages');
    assert(!selectionFollowUps(TAP).engageApproval, "the user's own selection engages through the click, not here");
    assert(!selectionFollowUps({ ...TAP, origin: 'auto', itemId: null }).engageApproval, 'a clear engages nothing');
  });

  return { passed, failed, errors };
}
