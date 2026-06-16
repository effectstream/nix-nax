// Shared deterministic key material for the test suites (arena edition).
// Each fixture pair plays in its own GAME on the shared arena contract: the
// pair carries a deterministic gameId, and every tree binds it.
//
// ROLL SCHEDULING: tests need scriptable action classes. All I-tree bits are
// 0; the R-tree bits per turn encode the schedule:
//   class 0 (remove): bits [0,0,0,0]  -> joint v = 0  (< 3)
//   class 1 (place):  bits [0,0,0,1]  -> joint v = 8  (>= 3)
// so classOfRoll(jointRollValue(...)) == schedule[t] for every slot/mover.

import { buildTokenTree, secretFor, type TokenTree } from "../../src/sdk/crypto/token-tree.ts";
import { buildIndexTree, SLOTS_PER_TURN, type IndexTree } from "../../src/sdk/crypto/index-tree.ts";
import { buildRandomTree, type RandomTree } from "../../src/sdk/crypto/random-tree.ts";
import { computePlayerId } from "../../src/sdk/crypto/persistent-hash.ts";
import { MAX_TURNS, type Kind } from "../../src/sdk/game/rules.ts";
import type { Intent, RandomReveal, MerklePath } from "../../src/sdk/crypto/signed-move.ts";

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
export const ZERO_PATH_14: MerklePath = {
  leaf: ZERO_BYTES32,
  path: Array.from({ length: 14 }, () => ({ sibling: { field: 0n }, goes_left: false })),
};

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

export function packChunk(pair: TestPair, baseTurn: number, moves: ScriptMove[]): SettleChunk {
  if (moves.length > CHUNK) throw new Error("chunk too large");
  const parities: bigint[] = new Array(CHUNK).fill(0n);
  const kinds: bigint[] = new Array(CHUNK).fill(0n);
  const cells: bigint[] = new Array(CHUNK).fill(0n);
  const sizes: bigint[] = new Array(CHUNK).fill(0n);
  const secrets: Uint8Array[] = new Array(CHUNK).fill(ZERO_BYTES32);
  const paths: MerklePath[] = new Array(CHUNK).fill(ZERO_PATH_14);

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
