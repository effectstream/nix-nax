// Per-player one-time-token Merkle tree builder.
//
// Layout — 9 turns × 9 cells = 81 leaves, depth-10 tree (1024 leaves total).
// Leaf index = turn * 9 + cell. Leaves beyond 81 are zero-bytes (Bytes<32>
// default).
//
// In-circuit verification (TicTacToeChannel.compact `tokenIsUnder`) does:
//   leaf = persistentHash(TokenPreimage{ domainSep, turn, cell, secret })
//   assert path.leaf == leaf
//   assert merkleTreePathRoot(path).field == root.field
//
// `merkleTreePathRoot` itself uses persistentHash(LeafPreimage{ "mdn:lh", leaf })
// (degraded to Field) as the bottom of the path, then folds entries with
// transientHash([left, right]). We mirror this exactly in
// `persistent-hash.ts`'s `merklePathRootField` / `combinePathEntry`.

import {
  computeTokenLeaf,
  hashLeafToField,
  combinePathEntry,
  merklePathRootField,
  randomBytes32,
} from "./persistent-hash.ts";

export const TREE_DEPTH = 10;
export const TREE_SIZE = 1 << TREE_DEPTH; // 1024
export const TURNS = 9;
export const CELLS = 9;
export const TOKEN_COUNT = TURNS * CELLS; // 81

export type PathEntry = { sibling: { field: bigint }; goes_left: boolean };
export type MerklePath = { leaf: Uint8Array; path: PathEntry[] };

export type TokenTree = {
  // root.field — matches the in-circuit MerkleTreeDigest.
  root: { field: bigint };
  // secrets[turn][cell] -> the 32-byte secret used as the token preimage.
  secrets: Uint8Array[][];
  // Build a Merkle path for (turn, cell) suitable for circuit consumption.
  pathFor: (turn: number, cell: number) => MerklePath;
};

export function buildTokenTree(rng: () => Uint8Array = randomBytes32): TokenTree {
  // Sample 81 secrets.
  const secrets: Uint8Array[][] = [];
  for (let t = 0; t < TURNS; t++) {
    secrets[t] = [];
    for (let c = 0; c < CELLS; c++) {
      secrets[t][c] = rng();
    }
  }

  // Leaf bytes for indices 0..80; pad to 1024 with 32-byte zero buffers.
  const leafBytes: Uint8Array[] = new Array(TREE_SIZE);
  for (let i = 0; i < TREE_SIZE; i++) {
    if (i < TOKEN_COUNT) {
      const t = Math.floor(i / CELLS);
      const c = i % CELLS;
      leafBytes[i] = computeTokenLeaf(t, c, secrets[t][c]);
    } else {
      leafBytes[i] = new Uint8Array(32);
    }
  }

  // Bottom level: each leaf hashed into a Field via the std-lib leaf-hash step.
  // Stored bottom-up: level 0 = leaves (size 1024), level 10 = root (size 1).
  const levels: bigint[][] = [];
  levels[0] = leafBytes.map(hashLeafToField);
  for (let depth = 1; depth <= TREE_DEPTH; depth++) {
    const prev = levels[depth - 1];
    const cur: bigint[] = new Array(prev.length / 2);
    for (let i = 0; i < cur.length; i++) {
      // Path-entry combine: at this level, the left child is index 2i, right is 2i+1.
      // For the canonical full-tree root computation we need to combine in the
      // same way the path verification does. The path verification folds
      // from a single leaf upward, so we replicate that by hashing pairs.
      //
      // The path traversal treats `goes_left = true` to mean "we are the left
      // child" (i.e., the recursive digest is the LEFT operand and the sibling
      // is the RIGHT). Symmetric: combinePathEntry with a synthetic entry.
      const leftField = prev[2 * i];
      const rightField = prev[2 * i + 1];
      // Use combinePathEntry with goes_left=true so leftField is the running
      // digest and rightField is the sibling.
      cur[i] = combinePathEntry(leftField, { sibling: { field: rightField }, goes_left: true });
    }
    levels[depth] = cur;
  }
  const root = { field: levels[TREE_DEPTH][0] };

  const pathFor = (turn: number, cell: number): MerklePath => {
    if (turn < 0 || turn >= TURNS) throw new Error("turn out of range");
    if (cell < 0 || cell >= CELLS) throw new Error("cell out of range");
    const leafIndex = turn * CELLS + cell;
    const leaf = leafBytes[leafIndex];

    // Build the merkle path: at each level, sibling is at index xor 1.
    let idx = leafIndex;
    const path: PathEntry[] = [];
    for (let depth = 0; depth < TREE_DEPTH; depth++) {
      const siblingIdx = idx ^ 1;
      const goesLeft = (idx & 1) === 0; // current node is the LEFT child
      path.push({
        sibling: { field: levels[depth][siblingIdx] },
        goes_left: goesLeft,
      });
      idx = idx >>> 1;
    }
    return { leaf, path };
  };

  // Sanity: re-derive the root from the first leaf path; must equal computed root.
  // (Cheap insurance — costs ~30 hashes, runs once at construction.)
  const firstPath = pathFor(0, 0);
  const derived = merklePathRootField(firstPath.leaf, firstPath.path);
  if (derived !== root.field) {
    throw new Error(
      `internal: tree root inconsistency. derived=${derived.toString(16)} stored=${root.field.toString(16)}`
    );
  }

  return { root, secrets, pathFor };
}
