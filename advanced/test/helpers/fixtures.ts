// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

// Shared deterministic key material for the test suites (arena edition).
// Each fixture pair plays in its own GAME on the shared arena contract: the
// pair carries a deterministic gameId, and every tree binds it.
//
// ROLL SCHEDULING: tests need scriptable action classes. All I-tree bits are
// 0; the R-tree bits per turn encode the schedule:
//   class 0 (remove): bits [0,0,0,0]  -> joint v = 0  (< 3)
//   class 1 (place):  bits [0,0,0,1]  -> joint v = 8  (>= 3)
// so classOfRoll(jointRollValue(...)) == schedule[t] for every slot/mover.

import {
  buildTokenTree,
  secretFor,
  actionOffset,
  actionFromOffset,
  ACTION_BLOCK,
  ACTIONS_PER_TURN,
  TOKEN_TREE_DEPTH,
  TOKEN_TREE_SIZE,
  type TokenTree,
} from "../../../src/sdk/crypto/token-tree.ts";
import { buildIndexTree, SLOTS_PER_TURN, INDEX_TREE_DEPTH, INDEX_TREE_SIZE, type IndexTree } from "../../../src/sdk/crypto/index-tree.ts";
import { buildRandomTree, type RandomTree } from "../../../src/sdk/crypto/random-tree.ts";
import {
  computePlayerId,
  computeIndexLeaf,
  computeRandomLeaf,
  computeTokenLeaf,
  buildMerkleLevels,
  pathFromLevels,
  randomBytes32,
  type MerklePath as HashMerklePath,
} from "../../../src/sdk/crypto/persistent-hash.ts";
import { MAX_TURNS, type Kind } from "../../../src/sdk/game/rules.ts";
import type { Intent, RandomReveal, MerklePath } from "../../../src/sdk/crypto/signed-move.ts";

export { SLOTS_PER_TURN };

// ── Deterministic RNG ───────────────────────────────────────────────────────

export function makeDetRng(seed: bigint): () => Uint8Array {
  let s = seed;
  return () => {
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      s = (s * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
      out[i] = Number((s >> 16n) & 0xffn);
    }
    return out;
  };
}

// ── Schedules ───────────────────────────────────────────────────────────────

// schedule[t] = action class of turn t (1 = place, 0 = remove/pass).
function mkSchedule(zeros: number[]): number[] {
  const s = new Array<number>(MAX_TURNS).fill(1);
  for (const t of zeros) s[t] = 0;
  return s;
}

// A: place-heavy, one O-side removal window at t5.
export const SCHEDULE_A = mkSchedule([5]);
// B: immediate removal + forced pass, X-side removal at t10.
export const SCHEDULE_B = mkSchedule([1, 2, 10]);
// C: all-place — for clean 4-in-a-row line wins (no removal can break a line).
export const SCHEDULE_C = mkSchedule([]);
// D: a single X-side removal window at t8 (even) — for removal-reveal wins.
export const SCHEDULE_D = mkSchedule([8]);
// E: every ODD turn is a removal (O removes on its turns, X places on evens) —
// the board never accumulates toward a line, so a full 128-turn game ends in a
// draw. Used to exercise the committedTurns==128 / drawNow / draw-mint paths.
export const SCHEDULE_E = mkSchedule(
  (() => { const odds: number[] = []; for (let t = 1; t < MAX_TURNS; t += 2) odds.push(t); return odds; })(),
);

// ── Players ─────────────────────────────────────────────────────────────────

export interface TestPlayer {
  secret: Uint8Array;
  id: Uint8Array;
  token: TokenTree;
  index: IndexTree;
  random: RandomTree;
}

export interface TestPair {
  gameId: Uint8Array;
  x: TestPlayer;
  o: TestPlayer;
  schedule: number[];
}

const pairCache = new Map<string, TestPair>();

export function buildPlayers(schedule: number[], cacheKey: string, gameSeed: bigint): TestPair {
  const hit = pairCache.get(cacheKey);
  if (hit) return hit;

  const gameId = makeDetRng(gameSeed)();

  const mk = (seed: bigint): TestPlayer => {
    const rng = makeDetRng(seed);
    const secret = rng();
    const token = buildTokenTree(gameId, rng);
    let slotIdx = 0;
    const index = buildIndexTree(
      gameId,
      rng,
      () => slotIdx++ % SLOTS_PER_TURN, // slots[t] = t % 16
      () => 0,                          // all I-bits 0
    );
    // R-bits encode the schedule: 4 bits per leaf in call order; bit position
    // 3 carries the class.
    let bitCall = 0;
    const rngBit = () => {
      const leaf = Math.floor(bitCall / 4);
      const t = Math.floor(leaf / SLOTS_PER_TURN);
      const pos = bitCall % 4;
      bitCall++;
      return pos === 3 && schedule[t] === 1 ? 1 : 0;
    };
    const random = buildRandomTree(gameId, rng, rngBit);
    return { secret, id: computePlayerId(gameId, secret), token, index, random };
  };

  const pair: TestPair = { gameId, x: mk(0x1001n), o: mk(0x2002n), schedule };
  pairCache.set(cacheKey, pair);
  return pair;
}

export const playersA = (): TestPair => buildPlayers(SCHEDULE_A, "A", 0xaaaa01n);
export const playersB = (): TestPair => buildPlayers(SCHEDULE_B, "B", 0xbbbb02n);
export const playersC = (): TestPair => buildPlayers(SCHEDULE_C, "C", 0xcccc03n);
export const playersD = (): TestPair => buildPlayers(SCHEDULE_D, "D", 0xdddd04n);
export const playersE = (): TestPair => buildPlayers(SCHEDULE_E, "E", 0xeeee05n);

// A pair with a RANDOM gameId (fresh trees each call, uncached). The e2e suite
// reuses one persisted arena across runs, and gameIds can never be reused on
// it — deterministic fixture ids would collide with games from prior runs.
export function freshPlayers(schedule: number[]): TestPair {
  const seedBytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(seedBytes);
  let seed = 0n;
  for (const b of seedBytes) seed = (seed << 8n) | BigInt(b);
  return buildPlayers(schedule, `fresh-${seed.toString(16)}`, seed);
}

export const hexOf = (b: Uint8Array): string =>
  Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");

// ── Ceremony builders ───────────────────────────────────────────────────────

export function moverOf(pair: TestPair, turn: number): TestPlayer {
  return turn % 2 === 0 ? pair.x : pair.o;
}
export function responderOf(pair: TestPair, turn: number): TestPlayer {
  return turn % 2 === 0 ? pair.o : pair.x;
}

export function intentFor(pair: TestPair, turn: number): Intent {
  const p = moverOf(pair, turn);
  return {
    channelId: hexOf(pair.gameId),
    turn,
    slot: p.index.slots[turn],
    bits: p.index.bits[turn].slice(),
    secret: p.index.secrets[turn],
    path: p.index.pathFor(turn),
  };
}

export function revealFor(pair: TestPair, turn: number, slot: number): RandomReveal {
  const p = responderOf(pair, turn);
  return {
    channelId: hexOf(pair.gameId),
    turn,
    slot,
    bits: p.random.bits[turn][slot].slice(),
    random: p.random.randoms[turn][slot],
    path: p.random.pathFor(turn, slot),
  };
}

// ── Settle chunk packing (contract sim + e2e) ───────────────────────────────

export interface ScriptMove {
  kind: Kind;
  cell: number;
  size: number;
  // Claimed class override (for wrong-parity fraud tests). Defaults to the
  // schedule's true class (turn 0 -> 1).
  lieParity?: 0 | 1;
}

export const ZERO_BYTES32 = new Uint8Array(32);
const zeroPath = (depth: number): MerklePath => ({
  leaf: ZERO_BYTES32,
  path: Array.from({ length: depth }, () => ({ sibling: { field: 0n }, goes_left: false })),
});
// Structurally-valid dummy paths (right depth, garbage contents) — for tests
// whose range/format asserts fire BEFORE the Merkle-path verification.
export const ZERO_PATH_14: MerklePath = zeroPath(14); // token tree
export const ZERO_PATH_7: MerklePath = zeroPath(7);   // index tree
export const ZERO_PATH_11: MerklePath = zeroPath(11); // random tree

const CHUNK = 8; // must match the contract's settle vector size

export interface SettleChunk {
  nMoves: bigint;
  parities: bigint[];
  kinds: bigint[];
  cells: bigint[];
  sizes: bigint[];
  secrets: Uint8Array[];
  paths: MerklePath[];
}

// chunkSize picks the settle variant the chunk targets (2 → settle2, 8 →
// settle, 16 → settle16); array lengths must match the entry point's vectors.
export function packChunk(pair: TestPair, baseTurn: number, moves: ScriptMove[], chunkSize: number = CHUNK): SettleChunk {
  if (moves.length > chunkSize) throw new Error("chunk too large");
  const parities: bigint[] = new Array(chunkSize).fill(0n);
  const kinds: bigint[] = new Array(chunkSize).fill(0n);
  const cells: bigint[] = new Array(chunkSize).fill(0n);
  const sizes: bigint[] = new Array(chunkSize).fill(0n);
  const secrets: Uint8Array[] = new Array(chunkSize).fill(ZERO_BYTES32);
  const paths: MerklePath[] = new Array(chunkSize).fill(ZERO_PATH_14);

  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    const turn = baseTurn + i;
    const mover = moverOf(pair, turn);
    const trueClass = turn === 0 ? 1 : pair.schedule[turn];
    const par = m.lieParity ?? trueClass;
    parities[i] = BigInt(par);
    kinds[i] = BigInt(m.kind);
    cells[i] = BigInt(m.cell);
    sizes[i] = BigInt(m.size);
    secrets[i] = secretFor(mover.token, turn, m.kind, m.cell, m.size);
    paths[i] = mover.token.pathFor(turn, m.kind, m.cell, m.size);
  }
  return { nMoves: BigInt(moves.length), parities, kinds, cells, sizes, secrets, paths };
}

// All-place 16-move script for a SCHEDULE_C pair (X even turns / O odd): X
// fills 0,1,2,4,5,6,8,9 (never 4 in a line); O fills 3,7,11,12,13,14,10,15 —
// the FINAL move (turn 15, cell 15) completes row3 {12,13,14,15} and col3
// {3,7,11,15}, so O wins exactly on the last move. Sized for one settle16.
export const SIXTEEN_C: ScriptMove[] = [
  { kind: 1, cell: 0, size: 0 }, { kind: 1, cell: 3, size: 0 },
  { kind: 1, cell: 1, size: 0 }, { kind: 1, cell: 7, size: 0 },
  { kind: 1, cell: 2, size: 0 }, { kind: 1, cell: 11, size: 0 },
  { kind: 1, cell: 4, size: 1 }, { kind: 1, cell: 12, size: 1 },
  { kind: 1, cell: 5, size: 1 }, { kind: 1, cell: 13, size: 1 },
  { kind: 1, cell: 6, size: 1 }, { kind: 1, cell: 14, size: 1 },
  { kind: 1, cell: 8, size: 2 }, { kind: 1, cell: 10, size: 2 },
  { kind: 1, cell: 9, size: 2 }, { kind: 1, cell: 15, size: 2 },
];

// ── Adversarial index tree (equivocation composition test) ──────────────────
// A malicious player builds an I-tree that commits a SECOND, different leaf for
// `evilTurn` at some OTHER position (`stashAt`). The honest ceremony leaf lives
// at index==evilTurn; the alternate lives at index==stashAt but is ALSO a valid
// leaf for `evilTurn` (its preimage's turn field is evilTurn), so both verify
// under the same root. This models a cheater who, when challenged, could answer
// with the alternate bits — and thereby hands the opponent two valid I-leaves
// for one turn, which proveIndexEquivocation slashes.
export interface MaliciousIndex {
  root: { field: bigint };
  // The honest leaf at index==turn (what the ceremony used).
  honest: (turn: number) => { slot: number; bits: number[]; secret: Uint8Array; path: MerklePath };
  // The stashed alternate leaf that is ALSO valid for `evilTurn`.
  alt: { slot: number; bits: number[]; secret: Uint8Array; path: MerklePath };
  evilTurn: number;
}

export interface MaliciousRandom {
  root: { field: bigint };
  bits: number[];
  random: Uint8Array;
  path: MerklePath;
}

// One semantically valid R leaf is deliberately committed at a different tree
// position. Root-only verification accepted this construction before C1.
export function buildMaliciousRandomTree(
  gameId: Uint8Array,
  turn: number,
  slot: number,
  stashAt: number,
  bits: number[] = [0, 0, 0, 0],
): MaliciousRandom {
  const leaves: Uint8Array[] = Array.from({ length: 1 << 11 }, () => new Uint8Array(32));
  const random = makeDetRng(0xc1c1n)();
  leaves[stashAt] = computeRandomLeaf(gameId, turn, slot, bits, random);
  const levels = buildMerkleLevels(leaves, 11);
  return {
    root: { field: levels[11][0] },
    bits,
    random,
    path: pathFromLevels(levels, leaves, stashAt, 11) as MerklePath,
  };
}

export function buildMaliciousIndexTree(
  gameId: Uint8Array,
  evilTurn: number,
  stashAt: number,
  honestSlots: number[],
  honestBits: number[][],
  altSlot: number,
  altBits: number[],
): MaliciousIndex {
  if (stashAt === evilTurn) throw new Error("stash must be a different position");
  const secrets: Uint8Array[] = [];
  const leafBytes: Uint8Array[] = new Array(INDEX_TREE_SIZE);
  const altSecret = randomBytes32();
  for (let t = 0; t < INDEX_TREE_SIZE; t++) {
    secrets[t] = randomBytes32();
    if (t === stashAt) {
      // Place a leaf whose PREIMAGE turn is evilTurn (not t) → a second valid
      // leaf for evilTurn, sitting at position stashAt.
      leafBytes[t] = computeIndexLeaf(gameId, evilTurn, altSlot, altBits, altSecret);
    } else {
      leafBytes[t] = computeIndexLeaf(gameId, t, honestSlots[t], honestBits[t], secrets[t]);
    }
  }
  const levels = buildMerkleLevels(leafBytes, INDEX_TREE_DEPTH);
  const root = { field: levels[INDEX_TREE_DEPTH][0] };
  return {
    root,
    honest: (turn: number) => ({
      slot: honestSlots[turn], bits: honestBits[turn], secret: secrets[turn],
      path: pathFromLevels(levels, leafBytes, turn, INDEX_TREE_DEPTH) as MerklePath,
    }),
    alt: {
      slot: altSlot, bits: altBits, secret: altSecret,
      path: pathFromLevels(levels, leafBytes, stashAt, INDEX_TREE_DEPTH) as MerklePath,
    },
    evilTurn,
  };
}

// ── Adversarial token tree (non-canonical action tokens) ────────────────────
// The honest T-tree only commits canonical actions (remove/pass ignore
// size/cell). A cheater could instead build a tree committing a token for a
// NON-canonical action — e.g. a remove with size≠0 or a pass with cell≠0 — to
// probe settle's canonical-form guards. This helper builds an otherwise-normal
// tree with one such token grafted in, and returns a valid path + secret for
// it (so tokenIsUnder passes and the canonical-form assert is what fires).
export interface MaliciousToken {
  root: { field: bigint };
  secret: Uint8Array;
  path: MerklePath;
}

export function buildMaliciousTokenTree(
  gameId: Uint8Array,
  evil: { turn: number; kind: number; cell: number; size: number },
): MaliciousToken {
  const tree = buildTokenTree(gameId); // full honest canonical tree
  // Recompute leaf bytes exactly as buildTokenTree does, then overwrite the
  // evil action's canonical slot with a leaf bound to the NON-canonical fields.
  const leafBytes: Uint8Array[] = new Array(TOKEN_TREE_SIZE);
  const zero = new Uint8Array(32);
  for (let i = 0; i < TOKEN_TREE_SIZE; i++) leafBytes[i] = zero;
  for (let t = 0; t < MAX_TURNS; t++) {
    for (let off = 0; off < ACTIONS_PER_TURN; off++) {
      const { kind, cell, size } = actionFromOffset(off);
      leafBytes[t * ACTION_BLOCK + off] = computeTokenLeaf(gameId, t, kind, cell, size, tree.secrets[t][off]);
    }
  }
  const evilOff = actionOffset(evil.kind, evil.cell, evil.size); // remove/pass → canonical slot
  const evilSecret = randomBytes32();
  const evilIdx = evil.turn * ACTION_BLOCK + evilOff;
  leafBytes[evilIdx] = computeTokenLeaf(gameId, evil.turn, evil.kind, evil.cell, evil.size, evilSecret);
  const levels = buildMerkleLevels(leafBytes, TOKEN_TREE_DEPTH);
  return {
    root: { field: levels[TOKEN_TREE_DEPTH][0] },
    secret: evilSecret,
    path: pathFromLevels(levels, leafBytes, evilIdx, TOKEN_TREE_DEPTH) as MerklePath,
  };
}
