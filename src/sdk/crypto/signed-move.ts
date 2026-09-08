// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

// Off-chain messages for the 4×4 stacked-pieces game (arena edition). The
// channelId of every message IS the gameId (32 bytes, hex-encoded) — all
// leaf preimages bind it, so nothing replays across games.
//
// Per turn t ≥ 1 (turn 0 is a bare SignedMove):
//   1. Intent (mover → responder): the mover's I-leaf — slot pick + FOUR
//      roll bits + salt + path.
//   2. RandomReveal (responder → mover): the responder's R-leaf at
//      (turn, slot) — random + FOUR roll bits + path.
//   3. SignedMove: the action, gated by the joint 4-bit roll
//      v = XOR-combine(bits) ∈ 0..15 — REMOVE class iff v < 3 (18.75%),
//      PLACE class otherwise — authorised by the mover's one-time action
//      token, embedding BOTH reveals in the hash-link.

import {
  computeTokenLeaf,
  computeIndexLeaf,
  computeRandomLeaf,
  hashBytes,
  merklePathRootField,
  type MerklePath,
} from "./persistent-hash.ts";
import {
  KIND_PLACE,
  MAX_TURNS,
  ROLL_BITS,
  applyAction,
  boardEquals,
  classOfRoll,
  emptyBoard,
  fullReserves,
  jointRollValue,
  moverForTurn,
  topsView,
  validateAction,
  winnerAfterMove,
  WIN_LINES,
  type Action,
  type Kind,
  type Mark,
} from "../game/rules.ts";

export type { MerklePath };

// ── Message types ───────────────────────────────────────────────────────────

export type Intent = {
  channelId: string;       // hex gameId
  turn: number;
  slot: number;            // 0..15 — picks the responder's R-leaf
  bits: number[];          // mover's four roll bits (each 0|1)
  secret: Uint8Array;      // 32-byte salt of the I-leaf
  path: MerklePath;        // depth 7, under the mover's I-root
};

export type RandomReveal = {
  channelId: string;
  turn: number;
  slot: number;            // must equal the intent's slot
  bits: number[];          // responder's four roll bits
  random: Uint8Array;      // 32 bytes — the turn's displayed random
  path: MerklePath;        // depth 11, under the responder's R-root
};

export type SignedMove = {
  channelId: string;
  turn: number;
  kind: Kind;
  cell: number;
  size: number;
  boardAfter: Uint8Array;    // 64 bytes (16 cells × 4 layers)
  reservesAfter: Uint8Array; // 8 bytes (2 marks × 4 sizes)
  prevHash: Uint8Array;      // 32 bytes; zero on turn 0
  token: { secret: Uint8Array; path: MerklePath }; // depth 14, mover's T-root
  indexReveal: Intent | null;        // null ONLY on turn 0
  randomReveal: RandomReveal | null; // null ONLY on turn 0
};

// Joint roll for a completed ceremony, and its action class.
export function jointRoll(intentBits: readonly number[], revealBits: readonly number[]): number {
  return jointRollValue(intentBits, revealBits);
}
export function rollClassOf(intentBits: readonly number[], revealBits: readonly number[]): 0 | 1 {
  return classOfRoll(jointRollValue(intentBits, revealBits));
}

const hexToBytes = (s: string): Uint8Array => {
  const m = (s.startsWith("0x") ? s.slice(2) : s).match(/.{1,2}/g) ?? [];
  return new Uint8Array(m.map((x) => parseInt(x, 16)));
};

function gameIdOf(channelId: string): Uint8Array {
  const b = hexToBytes(channelId);
  if (b.length !== 32) throw new Error("channelId must be a 32-byte hex gameId");
  return b;
}

function bitsOk(bits: readonly number[]): boolean {
  return bits.length === ROLL_BITS && bits.every((b) => b === 0 || b === 1);
}

function bitsNibble(bits: readonly number[]): number {
  return (bits[0] ?? 0) | ((bits[1] ?? 0) << 1) | ((bits[2] ?? 0) << 2) | ((bits[3] ?? 0) << 3);
}

// ── Hash-link ───────────────────────────────────────────────────────────────

export function encodeForChain(m: SignedMove): Uint8Array {
  const cid = hexToBytes(m.channelId);
  const idHash = new Uint8Array(32);
  idHash.set(cid.subarray(0, Math.min(cid.length, 32)));

  const header = new Uint8Array(32);
  header[0] = m.turn & 0xff;
  header[1] = m.kind & 0xff;
  header[2] = m.cell & 0xff;
  header[3] = m.size & 0xff;
  header[4] = m.indexReveal ? m.indexReveal.slot & 0xff : 0xff;
  header[5] = m.indexReveal ? bitsNibble(m.indexReveal.bits) : 0xff;
  header[6] = m.randomReveal ? bitsNibble(m.randomReveal.bits) : 0xff;

  const boardPadded = new Uint8Array(72);
  boardPadded.set(m.boardAfter.subarray(0, 64));
  boardPadded.set(m.reservesAfter.subarray(0, 8), 64);

  return concat(
    idHash,
    header,
    boardPadded,
    m.prevHash,
    m.token.secret,
    m.indexReveal ? m.indexReveal.secret : new Uint8Array(32),
    m.randomReveal ? m.randomReveal.random : new Uint8Array(32),
  );
}

export function hashSignedMove(m: SignedMove): Uint8Array {
  return hashBytes(encodeForChain(m));
}

// ── Stand-alone reveal verification (used mid-ceremony) ────────────────────

// Root parameters are NULLABLE: the simplified contract omits the advanced
// I/R ceremony roots (while still committing action-token roots on-chain), so
// a null I/R root skips ONLY this ceremony membership check. Every other
// integrity check (leaf preimage, legality, hash-link) still runs.
export function verifyIntent(
  it: Intent,
  expectedChannelId: string,
  expectedTurn: number,
  moverRootIdx: bigint | null,
): { ok: true } | { ok: false; reason: string } {
  if (it.channelId !== expectedChannelId) return { ok: false, reason: "intent: channelId mismatch" };
  if (it.turn !== expectedTurn) return { ok: false, reason: `intent: turn ${it.turn} != expected ${expectedTurn}` };
  if (!bitsOk(it.bits)) return { ok: false, reason: "intent: bits must be four 0/1 values" };
  if (it.slot < 0 || it.slot > 15) return { ok: false, reason: "intent: slot out of range" };
  const leaf = computeIndexLeaf(gameIdOf(it.channelId), it.turn, it.slot, it.bits, it.secret);
  if (!eqBytes(leaf, it.path.leaf)) return { ok: false, reason: "intent: leaf preimage mismatch" };
  if (moverRootIdx !== null && merklePathRootField(it.path.leaf, it.path.path) !== moverRootIdx) {
    return { ok: false, reason: "intent: not under the mover's I-root" };
  }
  return { ok: true };
}

export function verifyRandomReveal(
  r: RandomReveal,
  expectedChannelId: string,
  expectedTurn: number,
  expectedSlot: number,
  responderRootRnd: bigint | null,
): { ok: true } | { ok: false; reason: string } {
  if (r.channelId !== expectedChannelId) return { ok: false, reason: "random: channelId mismatch" };
  if (r.turn !== expectedTurn) return { ok: false, reason: `random: turn ${r.turn} != expected ${expectedTurn}` };
  if (r.slot !== expectedSlot) return { ok: false, reason: `random: slot ${r.slot} != expected ${expectedSlot}` };
  if (!bitsOk(r.bits)) return { ok: false, reason: "random: bits must be four 0/1 values" };
  if (r.random.length !== 32) return { ok: false, reason: "random: value must be 32 bytes" };
  const leaf = computeRandomLeaf(gameIdOf(r.channelId), r.turn, r.slot, r.bits, r.random);
  if (!eqBytes(leaf, r.path.leaf)) return { ok: false, reason: "random: leaf preimage mismatch" };
  if (responderRootRnd !== null && merklePathRootField(r.path.leaf, r.path.path) !== responderRootRnd) {
    return { ok: false, reason: "random: not under the responder's R-root" };
  }
  return { ok: true };
}

// ── Full move verification ──────────────────────────────────────────────────

export interface MoveVerifyRoots {
  moverRootToken: bigint | null;
  moverRootIdx: bigint | null;
  responderRootRnd: bigint | null;
}

export function verifySignedMove(
  m: SignedMove,
  prev: SignedMove | null,
  roots: MoveVerifyRoots,
): { ok: true } | { ok: false; reason: string } {
  const expectedPrev = prev ? hashSignedMove(prev) : new Uint8Array(32);
  if (!eqBytes(m.prevHash, expectedPrev)) {
    return { ok: false, reason: "hash-link mismatch (prevHash does not chain)" };
  }
  if (prev && m.turn !== prev.turn + 1) {
    return { ok: false, reason: `turn not contiguous (prev=${prev.turn}, this=${m.turn})` };
  }
  if (!prev && m.turn !== 0) {
    return { ok: false, reason: `first move must be turn 0, got ${m.turn}` };
  }
  if (m.turn >= MAX_TURNS) return { ok: false, reason: "turn exceeds MAX_TURNS" };

  const boardBefore = prev ? prev.boardAfter : emptyBoard();
  const reservesBefore = prev ? prev.reservesAfter : fullReserves();

  const topsB = topsView(boardBefore);
  // A win-line is FOUR tops in a row — must mirror rules.ts lineWinFor exactly.
  // (This previously destructured [a, b, c], dropping the 4th cell, so it wrongly
  // treated 3-in-a-row as a completed line and rejected the next move.)
  for (const [a, b, c, d] of WIN_LINES) {
    if (topsB[a] !== 0 && topsB[a] === topsB[b] && topsB[b] === topsB[c] && topsB[c] === topsB[d]) {
      return { ok: false, reason: "game already ended (a line exists on the board)" };
    }
  }

  const mark: Mark = moverForTurn(m.turn);

  let actionClass: 0 | 1 | null = null;
  if (m.turn === 0) {
    if (m.indexReveal !== null || m.randomReveal !== null) {
      return { ok: false, reason: "turn 0 must not carry a randomness ceremony" };
    }
  } else {
    if (!m.indexReveal || !m.randomReveal) {
      return { ok: false, reason: "missing randomness ceremony (intent/random reveal)" };
    }
    const vi = verifyIntent(m.indexReveal, m.channelId, m.turn, roots.moverRootIdx);
    if (!vi.ok) return vi;
    const vr = verifyRandomReveal(
      m.randomReveal, m.channelId, m.turn, m.indexReveal.slot, roots.responderRootRnd,
    );
    if (!vr.ok) return vr;
    actionClass = rollClassOf(m.indexReveal.bits, m.randomReveal.bits);
  }

  const action: Action = { kind: m.kind, cell: m.cell, size: m.size };
  const va = validateAction(boardBefore, reservesBefore, mark, actionClass, action);
  if (!va.ok) return va;

  const applied = applyAction(boardBefore, reservesBefore, mark, action);
  if (!boardEquals(applied.board, m.boardAfter)) {
    return { ok: false, reason: "boardAfter does not match prev + action" };
  }
  if (!boardEquals(applied.reserves, m.reservesAfter)) {
    return { ok: false, reason: "reservesAfter does not match prev + action" };
  }

  const expectedLeaf = computeTokenLeaf(gameIdOf(m.channelId), m.turn, m.kind, m.cell, m.size, m.token.secret);
  if (!eqBytes(expectedLeaf, m.token.path.leaf)) {
    return { ok: false, reason: "token leaf preimage mismatch" };
  }
  if (roots.moverRootToken !== null && merklePathRootField(m.token.path.leaf, m.token.path.path) !== roots.moverRootToken) {
    return { ok: false, reason: "token does not sit under the mover's T-root" };
  }
  return { ok: true };
}

export function winnerAfterSignedMove(m: SignedMove): Mark | 0 {
  return winnerAfterMove(m.boardAfter, moverForTurn(m.turn));
}

// ── Fraud-proof builders ────────────────────────────────────────────────────

export type EquivocationProof = {
  turn: number;
  kindA: number; cellA: number; sizeA: number; secretA: Uint8Array; pathA: MerklePath;
  kindB: number; cellB: number; sizeB: number; secretB: Uint8Array; pathB: MerklePath;
};

export function buildEquivocationProof(a: SignedMove, b: SignedMove): EquivocationProof {
  if (a.turn !== b.turn) throw new Error("not equivocation: turns differ");
  if (a.kind === b.kind && a.cell === b.cell && a.size === b.size) {
    throw new Error("not equivocation: same action");
  }
  return {
    turn: a.turn,
    kindA: a.kind, cellA: a.cell, sizeA: a.size, secretA: a.token.secret, pathA: a.token.path,
    kindB: b.kind, cellB: b.cell, sizeB: b.size, secretB: b.token.secret, pathB: b.token.path,
  };
}

export type IndexEquivocationProof = {
  turn: number;
  slotA: number; bitsA: number[]; secretA: Uint8Array; pathA: MerklePath;
  slotB: number; bitsB: number[]; secretB: Uint8Array; pathB: MerklePath;
};

export function buildIndexEquivocationProof(a: Intent, b: Intent): IndexEquivocationProof {
  if (a.turn !== b.turn) throw new Error("not equivocation: turns differ");
  if (a.slot === b.slot && bitsNibble(a.bits) === bitsNibble(b.bits)) {
    throw new Error("not equivocation: same index leaf");
  }
  return {
    turn: a.turn,
    slotA: a.slot, bitsA: a.bits, secretA: a.secret, pathA: a.path,
    slotB: b.slot, bitsB: b.bits, secretB: b.secret, pathB: b.path,
  };
}

export type RandomEquivocationProof = {
  turn: number;
  slot: number;
  bitsA: number[]; randomA: Uint8Array; pathA: MerklePath;
  bitsB: number[]; randomB: Uint8Array; pathB: MerklePath;
};

export function buildRandomEquivocationProof(a: RandomReveal, b: RandomReveal): RandomEquivocationProof {
  if (a.turn !== b.turn) throw new Error("not equivocation: turns differ");
  if (a.slot !== b.slot) throw new Error("not equivocation: slots differ");
  if (bitsNibble(a.bits) === bitsNibble(b.bits) && eqBytes(a.random, b.random)) {
    throw new Error("not equivocation: same random leaf");
  }
  return {
    turn: a.turn, slot: a.slot,
    bitsA: a.bits, randomA: a.random, pathA: a.path,
    bitsB: b.bits, randomB: b.random, pathB: b.path,
  };
}

export type WrongParityProof = {
  turn: number;
  slot: number;
  bitsI: number[]; secretI: Uint8Array; pathI: MerklePath;
  bitsR: number[]; randomR: Uint8Array; pathR: MerklePath;
};

export function buildWrongParityProof(intent: Intent, reveal: RandomReveal): WrongParityProof {
  if (intent.turn !== reveal.turn) throw new Error("wrong-parity proof: turns differ");
  if (intent.slot !== reveal.slot) throw new Error("wrong-parity proof: slots differ");
  return {
    turn: intent.turn,
    slot: intent.slot,
    bitsI: intent.bits, secretI: intent.secret, pathI: intent.path,
    bitsR: reveal.bits, randomR: reveal.random, pathR: reveal.path,
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────

function eqBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
