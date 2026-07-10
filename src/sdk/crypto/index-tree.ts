// Per-player I-tree: the mover's pre-committed (slot, parity-bit) per turn.
//
// Layout — 128 turns -> 128 leaves, depth-7 tree. Leaf index = turn.
// Leaf preimage: {domainSep "nixnax:idx:", turn, slot, bit, secret} where
//   slot ∈ 0..SLOTS_PER_TURN-1 — picks which of the opponent's per-turn
//     R-leaves is used for the joint random;
//   bit ∈ {0,1} — the mover's contribution to the XOR parity coin;
//   secret — 32-byte salt (slot+bit alone would be brute-forceable).
//
// In-circuit verification: NixNaxArena.compact `indexIsUnder` (depth 7).

import {
  computeIndexLeaf,
  buildMerkleLevels,
  pathFromLevels,
  merklePathRootField,
  randomBytes32,
  randomBit,
  type MerklePath,
  type PathEntry,
} from "./persistent-hash.ts";
import { MAX_TURNS } from "../game/rules.ts";

export type { MerklePath, PathEntry };

export const INDEX_TREE_DEPTH = 7;
export const INDEX_TREE_SIZE = 1 << INDEX_TREE_DEPTH; // 128
export const SLOTS_PER_TURN = 16;

export type IndexTree = {
  gameId: Uint8Array;
  root: { field: bigint };
  slots: number[];          // slots[turn] ∈ 0..15
  bits: number[][];         // bits[turn] = four 0/1 roll bits
  secrets: Uint8Array[];    // secrets[turn]
  pathFor: (turn: number) => MerklePath;
};

function randomSlot(): number {
  const b = new Uint8Array(1);
  globalThis.crypto.getRandomValues(b);
  return b[0] % SLOTS_PER_TURN; // 16 divides 256 — unbiased
}

// rngs consumed per turn 0..127: secret, slot, then FOUR bits.
export function buildIndexTree(
  gameId: Uint8Array,
  rngSecret: () => Uint8Array = randomBytes32,
  rngSlot: () => number = randomSlot,
  rngBit: () => number = randomBit,
): IndexTree {
  const slots: number[] = [];
  const bits: number[][] = [];
  const secrets: Uint8Array[] = [];
  for (let t = 0; t < MAX_TURNS; t++) {
    secrets[t] = rngSecret();
    slots[t] = rngSlot();
    bits[t] = [rngBit(), rngBit(), rngBit(), rngBit()];
  }

  const leafBytes: Uint8Array[] = new Array(INDEX_TREE_SIZE);
  for (let t = 0; t < INDEX_TREE_SIZE; t++) {
    leafBytes[t] = computeIndexLeaf(gameId, t, slots[t], bits[t], secrets[t]);
  }

  const levels = buildMerkleLevels(leafBytes, INDEX_TREE_DEPTH);
  const root = { field: levels[INDEX_TREE_DEPTH][0] };

  const pathFor = (turn: number): MerklePath => {
    if (turn < 0 || turn >= MAX_TURNS) throw new Error("turn out of range");
    return pathFromLevels(levels, leafBytes, turn, INDEX_TREE_DEPTH);
  };

  const p0 = pathFor(0);
  if (merklePathRootField(p0.leaf, p0.path) !== root.field) {
    throw new Error("internal: I-tree root inconsistency");
  }

  return { gameId, root, slots, bits, secrets, pathFor };
}
