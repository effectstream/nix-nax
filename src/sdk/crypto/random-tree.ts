// Per-player R-tree: the responder's pre-committed (random, parity-bit) per
// (turn, slot).
//
// Layout — 128 turns × 16 slots = 2,048 leaves, depth-11 tree. Leaf index =
// turn * 16 + slot. Leaf preimage: {domainSep "gob:rnd:", turn, slot, bit,
// random} where
//   bit ∈ {0,1} — the responder's contribution to the XOR parity coin;
//   random — 32 bytes, displayed in the UI as "the turn's random value"
//     (high entropy by itself, no extra salt needed).
//
// On turn t the mover reveals their I-leaf (slot s, bitI); the responder
// reveals this tree's leaf at (t, s). parity(t) = bitI XOR bitR.
//
// In-circuit verification: GobbletChannel.compact `randomIsUnder` (depth 11).

import {
  computeRandomLeaf,
  buildMerkleLevels,
  pathFromLevels,
  merklePathRootField,
  randomBytes32,
  randomBit,
  type MerklePath,
  type PathEntry,
} from "./persistent-hash.ts";
import { MAX_TURNS } from "../game/rules.ts";
import { SLOTS_PER_TURN } from "./index-tree.ts";

export type { MerklePath, PathEntry };
export { SLOTS_PER_TURN };

export const RAND_TREE_DEPTH = 11;
export const RAND_TREE_SIZE = 1 << RAND_TREE_DEPTH; // 2048
export const RAND_TOTAL = MAX_TURNS * SLOTS_PER_TURN; // 2048 — exactly fills the tree

export type RandomTree = {
  gameId: Uint8Array;
  root: { field: bigint };
  randoms: Uint8Array[][];   // randoms[turn][slot]
  bits: number[][][];        // bits[turn][slot] = four 0/1 roll bits
  pathFor: (turn: number, slot: number) => MerklePath;
};

// rngs consumed in (turn-major, slot) order: random then FOUR bits per leaf.
export function buildRandomTree(
  gameId: Uint8Array,
  rng: () => Uint8Array = randomBytes32,
  rngBit: () => number = randomBit,
): RandomTree {
  const randoms: Uint8Array[][] = [];
  const bits: number[][][] = [];
  for (let t = 0; t < MAX_TURNS; t++) {
    randoms[t] = [];
    bits[t] = [];
    for (let s = 0; s < SLOTS_PER_TURN; s++) {
      randoms[t][s] = rng();
      bits[t][s] = [rngBit(), rngBit(), rngBit(), rngBit()];
    }
  }

  const leafBytes: Uint8Array[] = new Array(RAND_TREE_SIZE);
  for (let i = 0; i < RAND_TREE_SIZE; i++) {
    const t = Math.floor(i / SLOTS_PER_TURN);
    const s = i % SLOTS_PER_TURN;
    leafBytes[i] = computeRandomLeaf(gameId, t, s, bits[t][s], randoms[t][s]);
  }

  const levels = buildMerkleLevels(leafBytes, RAND_TREE_DEPTH);
  const root = { field: levels[RAND_TREE_DEPTH][0] };

  const pathFor = (turn: number, slot: number): MerklePath => {
    if (turn < 0 || turn >= MAX_TURNS) throw new Error("turn out of range");
    if (slot < 0 || slot >= SLOTS_PER_TURN) throw new Error("slot out of range");
    return pathFromLevels(levels, leafBytes, turn * SLOTS_PER_TURN + slot, RAND_TREE_DEPTH);
  };

  const p0 = pathFor(0, 0);
  if (merklePathRootField(p0.leaf, p0.path) !== root.field) {
    throw new Error("internal: R-tree root inconsistency");
  }

  return { gameId, root, randoms, bits, pathFor };
}
