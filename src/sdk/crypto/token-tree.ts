// Per-player T-tree: one-time ACTION tokens for the 4×4 stacked-pieces game.
//
// Layout — 128 turns × a 128-slot block per turn, depth-14 tree (16,384
// leaves). Within a turn's block (4 sizes):
//   place  = size*16 + cell   (offsets  0..63)
//   remove = 64 + cell        (offsets 64..79)
//   pass   = 80               (offset 80)
// Offsets 81..127 and turns' unused leaves are zero-bytes padding. 81 real
// tokens per turn × 128 turns = 10,368 secrets.
//
// Leaf preimage binds the SEMANTICS (turn, kind, cell, size) — the position
// in the tree is just a client convention, exactly like the tic-tac-toe
// version. In-circuit verification: GobbletChannel.compact `tokenIsUnder`.

import {
  computeTokenLeaf,
  buildMerkleLevels,
  pathFromLevels,
  merklePathRootField,
  randomBytes32,
  type MerklePath,
  type PathEntry,
} from "./persistent-hash.ts";
import { KIND_PLACE, KIND_REMOVE, KIND_PASS, MAX_TURNS, CELLS, SIZES } from "../game/rules.ts";

export type { MerklePath, PathEntry };

export const TOKEN_TREE_DEPTH = 14;
export const TOKEN_TREE_SIZE = 1 << TOKEN_TREE_DEPTH; // 16384
export const ACTION_BLOCK = 128;                       // slots per turn
export const ACTIONS_PER_TURN = 81;                    // 64 places + 16 removes + 1 pass

// Offset of an action inside its turn block.
export function actionOffset(kind: number, cell: number, size: number): number {
  if (kind === KIND_PLACE) {
    if (cell < 0 || cell >= CELLS || size < 0 || size >= SIZES) throw new Error("bad place action");
    return size * 16 + cell;
  }
  if (kind === KIND_REMOVE) {
    if (cell < 0 || cell >= CELLS) throw new Error("bad remove action");
    return 64 + cell;
  }
  if (kind === KIND_PASS) return 80;
  throw new Error(`unknown kind ${kind}`);
}

// Inverse of actionOffset (canonical cell/size for remove/pass).
export function actionFromOffset(offset: number): { kind: number; cell: number; size: number } {
  if (offset >= 0 && offset < 64) return { kind: KIND_PLACE, cell: offset % 16, size: Math.floor(offset / 16) };
  if (offset >= 64 && offset < 80) return { kind: KIND_REMOVE, cell: offset - 64, size: 0 };
  if (offset === 80) return { kind: KIND_PASS, cell: 0, size: 0 };
  throw new Error(`offset ${offset} is not a real action slot`);
}

export type TokenTree = {
  gameId: Uint8Array;
  root: { field: bigint };
  // secrets[turn][offset] for offset 0..80 — rebuildable serialization unit.
  secrets: Uint8Array[][];
  pathFor: (turn: number, kind: number, cell: number, size: number) => MerklePath;
};

// rng is consumed in (turn-major, offset 0..80) order — 10,368 calls. Leaves
// bind the gameId so tokens can never replay across games.
export function buildTokenTree(gameId: Uint8Array, rng: () => Uint8Array = randomBytes32): TokenTree {
  const secrets: Uint8Array[][] = [];
  for (let t = 0; t < MAX_TURNS; t++) {
    secrets[t] = [];
    for (let off = 0; off < ACTIONS_PER_TURN; off++) {
      secrets[t][off] = rng();
    }
  }

  const leafBytes: Uint8Array[] = new Array(TOKEN_TREE_SIZE);
  const zero = new Uint8Array(32);
  for (let i = 0; i < TOKEN_TREE_SIZE; i++) leafBytes[i] = zero;
  for (let t = 0; t < MAX_TURNS; t++) {
    for (let off = 0; off < ACTIONS_PER_TURN; off++) {
      const { kind, cell, size } = actionFromOffset(off);
      leafBytes[t * ACTION_BLOCK + off] = computeTokenLeaf(gameId, t, kind, cell, size, secrets[t][off]);
    }
  }

  const levels = buildMerkleLevels(leafBytes, TOKEN_TREE_DEPTH);
  const root = { field: levels[TOKEN_TREE_DEPTH][0] };

  const pathFor = (turn: number, kind: number, cell: number, size: number): MerklePath => {
    if (turn < 0 || turn >= MAX_TURNS) throw new Error("turn out of range");
    const off = actionOffset(kind, cell, size);
    return pathFromLevels(levels, leafBytes, turn * ACTION_BLOCK + off, TOKEN_TREE_DEPTH);
  };

  // Sanity: derive the root from one real path.
  const p0 = pathFor(0, KIND_PLACE, 0, 0);
  if (merklePathRootField(p0.leaf, p0.path) !== root.field) {
    throw new Error("internal: T-tree root inconsistency");
  }

  return { gameId, root, secrets, pathFor };
}

// Secret for a specific action — convenience for move building.
export function secretFor(tree: TokenTree, turn: number, kind: number, cell: number, size: number): Uint8Array {
  return tree.secrets[turn][actionOffset(kind, cell, size)];
}
