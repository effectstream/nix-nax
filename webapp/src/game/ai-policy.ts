// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

// AI move policy — the single swappable seam for the "Practice vs AI" feature.
// v1 is a basic heuristic (win → block → greedy place / threat-remove / pass).
// It reads everything from rules.ts, so it automatically targets the live
// rules (4 sizes, 4-in-a-row on the visible tops). Swap `chooseAction` for a
// stronger search (minimax/MCTS) later without touching the AI driver.

import {
  WIN_LINES,
  CELLS,
  SIZES,
  KIND_PLACE,
  KIND_REMOVE,
  KIND_PASS,
  canPlace,
  canRemove,
  topsView,
  applyAction,
  opp,
  type Action,
  type Mark,
} from "../../../src/sdk/game/rules.ts";

// Does `mark` already occupy a whole win-line on the tops view?
function hasWin(tops: Uint8Array, mark: Mark): boolean {
  for (const line of WIN_LINES) {
    let all = true;
    for (const c of line) if (tops[c] !== mark) { all = false; break; }
    if (all) return true;
  }
  return false;
}

// Heuristic: reward lines where `mark` has pieces and the opponent has none
// (still winnable), weighted super-linearly so 3-of-4 is far better than 1.
function topsScore(tops: Uint8Array, mark: Mark): number {
  const foe = opp(mark);
  let score = 0;
  for (const line of WIN_LINES) {
    let mine = 0;
    let theirs = 0;
    for (const c of line) {
      if (tops[c] === mark) mine++;
      else if (tops[c] === foe) theirs++;
    }
    if (theirs === 0 && mine > 0) score += mine * mine;
  }
  return score;
}

function* placements(board: Uint8Array, reserves: Uint8Array, mark: Mark): Generator<Action> {
  for (let size = 0; size < SIZES; size++) {
    for (let cell = 0; cell < CELLS; cell++) {
      if (canPlace(board, reserves, mark, size, cell)) yield { kind: KIND_PLACE, cell, size };
    }
  }
}

// Choose an action for `mark` given the turn's class (1 = place, 0 = remove/pass).
// Returns null only if it's a place turn with no legal placement (stalled).
export function chooseAction(
  board: Uint8Array,
  reserves: Uint8Array,
  mark: Mark,
  parity: 0 | 1,
): Action | null {
  const foe = opp(mark);

  if (parity === 1) {
    // 1) Win now.
    for (const a of placements(board, reserves, mark)) {
      if (hasWin(topsView(applyAction(board, reserves, mark, a).board), mark)) return a;
    }
    // 2) Block: which cells would let the opponent complete a line next turn?
    const threatCells = new Set<number>();
    for (const a of placements(board, reserves, foe)) {
      if (hasWin(topsView(applyAction(board, reserves, foe, a).board), foe)) threatCells.add(a.cell);
    }
    if (threatCells.size) {
      // Cover a threatened cell with the smallest piece that can.
      let best: Action | null = null;
      for (const a of placements(board, reserves, mark)) {
        if (threatCells.has(a.cell) && (!best || a.size < best.size)) best = a;
      }
      if (best) return best;
    }
    // 3) Greedy: maximise my line potential minus the opponent's, prefer small.
    let best: Action | null = null;
    let bestScore = -Infinity;
    for (const a of placements(board, reserves, mark)) {
      const tops = topsView(applyAction(board, reserves, mark, a).board);
      const s = topsScore(tops, mark) - 0.6 * topsScore(tops, foe) - a.size * 0.01;
      if (s > bestScore) { bestScore = s; best = a; }
    }
    return best; // null ⇒ stalled (no legal placement)
  }

  // REMOVE turn: take the opponent top that most reduces their line potential.
  let best: Action | null = null;
  let bestGain = -Infinity;
  const beforeFoe = topsScore(topsView(board), foe);
  for (let cell = 0; cell < CELLS; cell++) {
    if (!canRemove(board, mark, cell)) continue;
    const a: Action = { kind: KIND_REMOVE, cell, size: 0 };
    const tops = topsView(applyAction(board, reserves, mark, a).board);
    const gain = beforeFoe - topsScore(tops, foe) + topsScore(tops, mark) * 0.1;
    if (gain > bestGain) { bestGain = gain; best = a; }
  }
  return best ?? { kind: KIND_PASS, cell: 0, size: 0 };
}
