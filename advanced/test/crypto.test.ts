// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

// Crypto + rules tests (arena edition) — trees bound to a gameId, leaf
// encodings with 4 roll bits, the joint roll + class, the three-message
// ceremony, SignedMove verification, fraud-proof builders, and wire serde.

import { describe, test, expect } from "vitest";
import {
  computeTokenLeaf,
  computeIndexLeaf,
  computeRandomLeaf,
  computePlayerId,
  merklePathRootField,
} from "../../src/sdk/crypto/persistent-hash.ts";
import {
  actionOffset,
  actionFromOffset,
  secretFor,
  ACTIONS_PER_TURN,
} from "../../src/sdk/crypto/token-tree.ts";
import {
  hashSignedMove,
  jointRoll,
  rollClassOf,
  verifyIntent,
  verifyRandomReveal,
  merklePathPosition,
  verifySignedMove,
  buildEquivocationProof,
  buildIndexEquivocationProof,
  buildRandomEquivocationProof,
  buildWrongParityProof,
  type SignedMove,
  type MoveVerifyRoots,
} from "../../src/sdk/crypto/signed-move.ts";
import {
  KIND_PLACE,
  KIND_REMOVE,
  KIND_PASS,
  ROLL_REMOVE_THRESHOLD,
  applyAction,
  canPlace,
  classOfRoll,
  emptyBoard,
  fullReserves,
  jointRollValue,
  moverForTurn,
  topOf,
  validateAction,
  winnerAfterMove,
  WIN_LINES,
  reserveIndex,
  type Action,
  type Mark,
} from "../../src/sdk/game/rules.ts";
import { encodeMove, decodeMove } from "../../src/sdk/game/messaging.ts";
import {
  playersA,
  playersB,
  playersC,
  hexOf,
  intentFor,
  revealFor,
  moverOf,
  type TestPair,
} from "./helpers/fixtures.ts";

// ── Rules ───────────────────────────────────────────────────────────────────

describe("rules", () => {
  test("there are exactly 10 win lines", () => {
    expect(WIN_LINES.length).toBe(10);
    const seen = new Set(WIN_LINES.map((l) => l.join(",")));
    expect(seen.size).toBe(10);
  });

  test("the 4-bit roll: XOR combine + remove threshold (3/16)", () => {
    expect(jointRollValue([0, 0, 0, 0], [0, 0, 0, 0])).toBe(0);
    expect(jointRollValue([1, 0, 0, 0], [0, 0, 0, 0])).toBe(1);
    expect(jointRollValue([1, 1, 0, 0], [0, 1, 0, 0])).toBe(1); // bit1 cancels
    expect(jointRollValue([0, 0, 0, 1], [0, 0, 0, 0])).toBe(8);
    expect(jointRollValue([1, 1, 1, 1], [1, 1, 1, 1])).toBe(0);
    // Class boundary.
    expect(classOfRoll(0)).toBe(0);
    expect(classOfRoll(ROLL_REMOVE_THRESHOLD - 1)).toBe(0);
    expect(classOfRoll(ROLL_REMOVE_THRESHOLD)).toBe(1);
    expect(classOfRoll(15)).toBe(1);
    // Exactly 3 of 16 rolls are remove-class.
    let removes = 0;
    for (let v = 0; v < 16; v++) if (classOfRoll(v) === 0) removes++;
    expect(removes).toBe(3);
  });

  test("stacking matrix: strictly larger covers; equal/smaller rejected", () => {
    let board = emptyBoard();
    const reserves = fullReserves();
    board = applyAction(board, reserves, 1, { kind: KIND_PLACE, cell: 5, size: 1 }).board;
    expect(canPlace(board, reserves, 2, 0, 5)).toBe(false);
    expect(canPlace(board, reserves, 2, 1, 5)).toBe(false);
    expect(canPlace(board, reserves, 2, 2, 5)).toBe(true);
    expect(canPlace(board, reserves, 1, 2, 5)).toBe(true);
  });

  test("remove returns the piece to its OWNER and reveals beneath", () => {
    let board = emptyBoard();
    let reserves = fullReserves();
    ({ board, reserves } = applyAction(board, reserves, 1, { kind: KIND_PLACE, cell: 5, size: 0 }));
    ({ board, reserves } = applyAction(board, reserves, 2, { kind: KIND_PLACE, cell: 5, size: 2 }));
    expect(topOf(board, 5)).toEqual({ layer: 2, mark: 2 });
    const r = applyAction(board, reserves, 1, { kind: KIND_REMOVE, cell: 5, size: 0 });
    expect(r.removed).toEqual({ mark: 2, size: 2 });
    expect(topOf(r.board, 5)).toEqual({ layer: 0, mark: 1 });
    expect(r.reserves[reserveIndex(2, 2)]).toBe(3);
  });

  test("winnerAfterMove: mover precedence on a double reveal", () => {
    let board = emptyBoard();
    const reserves = fullReserves();
    const put = (cell: number, size: number, mark: Mark) => {
      board = applyAction(board, reserves, mark, { kind: KIND_PLACE, cell, size }).board;
    };
    put(0, 0, 1); put(1, 0, 1); put(2, 0, 1); put(3, 0, 1);   // X fills row 0
    put(4, 0, 2); put(5, 0, 2); put(6, 0, 2); put(7, 0, 2);   // O fills row 1
    expect(winnerAfterMove(board, 1)).toBe(1);
    expect(winnerAfterMove(board, 2)).toBe(2);
  });

  test("class gates the action kind", () => {
    const board = emptyBoard();
    const reserves = fullReserves();
    const place: Action = { kind: KIND_PLACE, cell: 0, size: 0 };
    expect(validateAction(board, reserves, 1, 1, place).ok).toBe(true);
    expect(validateAction(board, reserves, 1, 0, place).ok).toBe(false);
    const pass: Action = { kind: KIND_PASS, cell: 0, size: 0 };
    expect(validateAction(board, reserves, 1, 0, pass).ok).toBe(true);
    expect(validateAction(board, reserves, 1, 1, pass).ok).toBe(false);
  });
});

// ── Trees ───────────────────────────────────────────────────────────────────

describe("trees", () => {
  test("action offsets round-trip all 81 real slots", () => {
    for (let off = 0; off < ACTIONS_PER_TURN; off++) {
      const a = actionFromOffset(off);
      expect(actionOffset(a.kind, a.cell, a.size)).toBe(off);
    }
  });

  test("identity binds the gameId", () => {
    const a = playersA();
    const b = playersB();
    // Same X seed (0x1001) in both fixtures, but different gameIds -> ids differ.
    expect(hexOf(computePlayerId(a.gameId, a.x.secret)))
      .not.toBe(hexOf(computePlayerId(b.gameId, a.x.secret)));
  });

  test("T-tree: sampled action paths verify; leaf binds (gameId, turn, kind, cell, size)", () => {
    const { gameId, x } = playersA();
    const samples: [number, number, number, number][] = [
      [0, KIND_PLACE, 0, 0], [7, KIND_PLACE, 15, 2], [42, KIND_REMOVE, 9, 0], [127, KIND_PASS, 0, 0],
    ];
    for (const [turn, kind, cell, size] of samples) {
      const p = x.token.pathFor(turn, kind, cell, size);
      const leaf = computeTokenLeaf(gameId, turn, kind, cell, size, secretFor(x.token, turn, kind, cell, size));
      expect(Buffer.from(p.leaf)).toEqual(Buffer.from(leaf));
      expect(merklePathRootField(p.leaf, p.path)).toBe(x.token.root.field);
      expect(p.path.length).toBe(14);
    }
    // A different gameId changes the leaf.
    const otherGid = new Uint8Array(32).fill(9);
    const p0 = x.token.pathFor(0, KIND_PLACE, 0, 0);
    const altLeaf = computeTokenLeaf(otherGid, 0, KIND_PLACE, 0, 0, secretFor(x.token, 0, KIND_PLACE, 0, 0));
    expect(Buffer.from(p0.leaf)).not.toEqual(Buffer.from(altLeaf));
  });

  test("I-tree: per-turn leaves verify (depth 7, four bits)", () => {
    const { gameId, o } = playersA();
    for (const turn of [0, 17, 127]) {
      const p = o.index.pathFor(turn);
      const leaf = computeIndexLeaf(gameId, turn, o.index.slots[turn], o.index.bits[turn], o.index.secrets[turn]);
      expect(Buffer.from(p.leaf)).toEqual(Buffer.from(leaf));
      expect(merklePathRootField(p.leaf, p.path)).toBe(o.index.root.field);
      expect(p.path.length).toBe(7);
      expect(o.index.bits[turn]).toHaveLength(4);
    }
  });

  test("R-tree: per-(turn, slot) leaves verify (depth 11, four bits)", () => {
    const { gameId, x } = playersA();
    for (const [turn, slot] of [[0, 0], [63, 15], [127, 7]] as const) {
      const p = x.random.pathFor(turn, slot);
      const leaf = computeRandomLeaf(gameId, turn, slot, x.random.bits[turn][slot], x.random.randoms[turn][slot]);
      expect(Buffer.from(p.leaf)).toEqual(Buffer.from(leaf));
      expect(merklePathRootField(p.leaf, p.path)).toBe(x.random.root.field);
      expect(p.path.length).toBe(11);
    }
  });

  test("a wrong secret does not verify", () => {
    const { gameId, x } = playersA();
    const p = x.token.pathFor(3, KIND_PLACE, 4, 1);
    const wrongLeaf = computeTokenLeaf(gameId, 3, KIND_PLACE, 4, 1, new Uint8Array(32));
    expect(merklePathRootField(wrongLeaf, p.path)).not.toBe(x.token.root.field);
  });
});

// ── Ceremony ────────────────────────────────────────────────────────────────

describe("ceremony (intent + random reveal)", () => {
  test("I/R paths expose the canonical leaf-first position at both boundaries", () => {
    const pair = playersA();
    for (const turn of [0, 127]) {
      const it = intentFor(pair, turn);
      expect(merklePathPosition(it.path)).toBe(turn);
      const rv0 = revealFor(pair, turn, 0);
      const rv15 = revealFor(pair, turn, 15);
      expect(merklePathPosition(rv0.path)).toBe(turn * 16);
      expect(merklePathPosition(rv15.path)).toBe(turn * 16 + 15);
    }
  });

  test("shared reveal verification rejects a root member at a noncanonical position", () => {
    const pair = playersA();
    const cid = hexOf(pair.gameId);
    const it = intentFor(pair, 3);
    const badI = {
      ...it,
      path: { ...it.path, path: it.path.path.map((entry, i) => i === 0 ? { ...entry, goes_left: !entry.goes_left } : entry) },
    };
    const vi = verifyIntent(badI, cid, 3, pair.o.index.root.field);
    expect(vi.ok).toBe(false);
    if (!vi.ok) expect(vi.reason).toMatch(/canonical turn position/);

    const rv = revealFor(pair, 3, it.slot);
    const badR = {
      ...rv,
      path: { ...rv.path, path: rv.path.path.map((entry, i) => i === 4 ? { ...entry, goes_left: !entry.goes_left } : entry) },
    };
    const vr = verifyRandomReveal(badR, cid, 3, it.slot, pair.x.random.root.field);
    expect(vr.ok).toBe(false);
    if (!vr.ok) expect(vr.reason).toMatch(/canonical turn\/slot position/);
  });

  test("honest intent + reveal verify; tampered ones do not", () => {
    const pair = playersA();
    const cid = hexOf(pair.gameId);
    const it = intentFor(pair, 3);                 // t3: mover O
    expect(verifyIntent(it, cid, 3, pair.o.index.root.field).ok).toBe(true);
    expect(verifyIntent(it, cid, 3, pair.x.index.root.field).ok).toBe(false);
    expect(verifyIntent({ ...it, slot: (it.slot + 1) % 16 }, cid, 3, pair.o.index.root.field).ok).toBe(false);
    expect(verifyIntent({ ...it, bits: [1, ...it.bits.slice(1)] }, cid, 3, pair.o.index.root.field).ok).toBe(false);

    const rv = revealFor(pair, 3, it.slot);        // responder X
    expect(verifyRandomReveal(rv, cid, 3, it.slot, pair.x.random.root.field).ok).toBe(true);
    expect(verifyRandomReveal(rv, cid, 3, (it.slot + 1) % 16, pair.x.random.root.field).ok).toBe(false);
    const flipped = { ...rv, bits: rv.bits.map((b, i) => (i === 0 ? b ^ 1 : b)) };
    expect(verifyRandomReveal(flipped, cid, 3, it.slot, pair.x.random.root.field).ok).toBe(false);
  });

  test("schedule fixtures produce the intended classes", () => {
    const pair = playersA();
    for (const t of [1, 2, 3, 4, 6]) {
      const it = intentFor(pair, t);
      const rv = revealFor(pair, t, it.slot);
      expect(rollClassOf(it.bits, rv.bits)).toBe(1); // place turns
    }
    const it5 = intentFor(pair, 5);
    const rv5 = revealFor(pair, 5, it5.slot);
    expect(jointRoll(it5.bits, rv5.bits)).toBe(0);
    expect(rollClassOf(it5.bits, rv5.bits)).toBe(0); // the removal window
  });
});

// ── SignedMove verification ─────────────────────────────────────────────────

function buildMove(pair: TestPair, turn: number, action: Action, prev: SignedMove | null): SignedMove {
  const mover = moverOf(pair, turn);
  const mark = moverForTurn(turn);
  const boardBefore = prev ? prev.boardAfter : emptyBoard();
  const reservesBefore = prev ? prev.reservesAfter : fullReserves();
  const applied = applyAction(boardBefore, reservesBefore, mark, action);
  const indexReveal = turn === 0 ? null : intentFor(pair, turn);
  const randomReveal = turn === 0 ? null : revealFor(pair, turn, indexReveal!.slot);
  return {
    channelId: hexOf(pair.gameId),
    turn,
    kind: action.kind,
    cell: action.cell,
    size: action.size,
    boardAfter: applied.board,
    reservesAfter: applied.reserves,
    prevHash: prev ? hashSignedMove(prev) : new Uint8Array(32),
    token: {
      secret: secretFor(mover.token, turn, action.kind, action.cell, action.size),
      path: mover.token.pathFor(turn, action.kind, action.cell, action.size),
    },
    indexReveal,
    randomReveal,
  };
}

function rootsFor(pair: TestPair, turn: number): MoveVerifyRoots {
  const mover = moverOf(pair, turn);
  const responder = turn % 2 === 0 ? pair.o : pair.x;
  return {
    moverRootToken: mover.token.root.field,
    moverRootIdx: mover.index.root.field,
    responderRootRnd: responder.random.root.field,
  };
}

describe("verifySignedMove", () => {
  test("honest place / remove / pass sequence verifies (schedule B)", () => {
    const pair = playersB();
    const m0 = buildMove(pair, 0, { kind: KIND_PLACE, cell: 0, size: 0 }, null);
    expect(verifySignedMove(m0, null, rootsFor(pair, 0)).ok).toBe(true);
    const m1 = buildMove(pair, 1, { kind: KIND_REMOVE, cell: 0, size: 0 }, m0);
    expect(verifySignedMove(m1, m0, rootsFor(pair, 1)).ok).toBe(true);
    const m2 = buildMove(pair, 2, { kind: KIND_PASS, cell: 0, size: 0 }, m1);
    expect(verifySignedMove(m2, m1, rootsFor(pair, 2)).ok).toBe(true);
    const m3 = buildMove(pair, 3, { kind: KIND_PLACE, cell: 9, size: 1 }, m2);
    expect(verifySignedMove(m3, m2, rootsFor(pair, 3)).ok).toBe(true);
  });

  test("action against the joint roll class is rejected", () => {
    const pair = playersA();
    let prev: SignedMove | null = null;
    const cells = [2, 4, 0, 15, 5];
    for (let t = 0; t < 5; t++) {
      prev = buildMove(pair, t, { kind: KIND_PLACE, cell: cells[t], size: 0 }, prev);
    }
    const bad = buildMove(pair, 5, { kind: KIND_PLACE, cell: 9, size: 0 }, prev);
    const r = verifySignedMove(bad, prev, rootsFor(pair, 5));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/odd random|place requires/);
  });

  test("tampered boardAfter / broken hash-link / wrong roots are rejected", () => {
    const pair = playersA();
    const m0 = buildMove(pair, 0, { kind: KIND_PLACE, cell: 0, size: 0 }, null);
    const m1 = buildMove(pair, 1, { kind: KIND_PLACE, cell: 4, size: 0 }, m0);

    const tampered = { ...m1, boardAfter: emptyBoard() };
    expect(verifySignedMove(tampered, m0, rootsFor(pair, 1)).ok).toBe(false);

    const badLink = { ...m1, prevHash: new Uint8Array(32) };
    const r2 = verifySignedMove(badLink, m0, rootsFor(pair, 1));
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toMatch(/hash-link/);

    expect(verifySignedMove(m1, m0, rootsFor(pair, 0)).ok).toBe(false);
  });

  test("turn >= 1 without a ceremony is rejected; turn 0 with one is rejected", () => {
    const pair = playersA();
    const m0 = buildMove(pair, 0, { kind: KIND_PLACE, cell: 0, size: 0 }, null);
    const m1 = buildMove(pair, 1, { kind: KIND_PLACE, cell: 4, size: 0 }, m0);
    const stripped = { ...m1, indexReveal: null, randomReveal: null };
    const r = verifySignedMove(stripped, m0, rootsFor(pair, 1));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/missing randomness ceremony/);

    const withCeremony = { ...m0, indexReveal: intentFor(pair, 2) };
    expect(verifySignedMove(withCeremony as SignedMove, null, rootsFor(pair, 0)).ok).toBe(false);
  });

  test("3-in-a-row does NOT end the game — play continues", () => {
    // Regression: the "already ended" guard once destructured win lines as
    // [a,b,c] (3 cells), so 3 aligned tops froze the game. A line is FOUR.
    const pair = playersC(); // all-place — no removals to disturb the tops
    let prev: SignedMove | null = null;
    // X (even turns) takes c0,c1,c2 — three of row 0, c3 still EMPTY.
    const script: [number, number][] = [[0, 0], [4, 0], [1, 0], [5, 0], [2, 0]];
    for (let t = 0; t < script.length; t++) {
      const m = buildMove(pair, t, { kind: KIND_PLACE, cell: script[t][0], size: script[t][1] }, prev);
      expect(verifySignedMove(m, prev, rootsFor(pair, t)).ok).toBe(true);
      prev = m;
    }
    // Turn 5's board has X's 3-in-a-row; with only 3 of 4 cells it is NOT a win,
    // so the next move must still verify.
    const next = buildMove(pair, 5, { kind: KIND_PLACE, cell: 6, size: 0 }, prev);
    expect(verifySignedMove(next, prev, rootsFor(pair, 5)).ok).toBe(true);
  });

  test("moves after a finished game (real 4-in-a-row) are rejected", () => {
    const pair = playersC(); // all-place
    let prev: SignedMove | null = null;
    // X (even) fills row 0 c0..c3; O (odd) fills row 1. X completes the line at
    // turn 6. X uses one piece of each size (0..3) so it never runs a size out.
    const script: [number, number][] = [[0, 0], [4, 0], [1, 1], [5, 0], [2, 2], [6, 0], [3, 3]];
    for (let t = 0; t < script.length; t++) {
      const m = buildMove(pair, t, { kind: KIND_PLACE, cell: script[t][0], size: script[t][1] }, prev);
      expect(verifySignedMove(m, prev, rootsFor(pair, t)).ok).toBe(true); // every move up to & incl. the win is legal
      prev = m;
    }
    // boardBefore now holds X's full c0,c1,c2,c3 line — the next move is rejected.
    const after = buildMove(pair, 7, { kind: KIND_PLACE, cell: 7, size: 0 }, prev);
    const r = verifySignedMove(after, prev, rootsFor(pair, 7));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/game already ended/);
  });
});

// ── Builders + serde ────────────────────────────────────────────────────────

describe("fraud-proof builders", () => {
  test("equivocation: two different actions for one turn", () => {
    const pair = playersA();
    const a = buildMove(pair, 0, { kind: KIND_PLACE, cell: 0, size: 0 }, null);
    const b = buildMove(pair, 0, { kind: KIND_PLACE, cell: 5, size: 1 }, null);
    const proof = buildEquivocationProof(a, b);
    expect(proof.turn).toBe(0);
    expect(proof.cellA).toBe(0);
    expect(proof.cellB).toBe(5);
    expect(() => buildEquivocationProof(a, a)).toThrow(/same action/);
  });

  test("index/random equivocation builders demand a real fork", () => {
    const pair = playersA();
    const it = intentFor(pair, 3);
    expect(() => buildIndexEquivocationProof(it, it)).toThrow(/same index leaf/);
    const forked = { ...it, slot: (it.slot + 1) % 16 };
    const ip = buildIndexEquivocationProof(it, forked);
    expect(ip.turn).toBe(3);
    const bitFork = { ...it, bits: it.bits.map((b, i) => (i === 2 ? b ^ 1 : b)) };
    expect(buildIndexEquivocationProof(it, bitFork).turn).toBe(3);

    const rv = revealFor(pair, 3, it.slot);
    expect(() => buildRandomEquivocationProof(rv, rv)).toThrow(/same random leaf/);
    const rForked = { ...rv, bits: rv.bits.map((b, i) => (i === 0 ? b ^ 1 : b)) };
    const rp = buildRandomEquivocationProof(rv, rForked);
    expect(rp.slot).toBe(it.slot);
  });

  test("wrong-parity proof packages the turn's two reveals", () => {
    const pair = playersA();
    const it = intentFor(pair, 5);
    const rv = revealFor(pair, 5, it.slot);
    const p = buildWrongParityProof(it, rv);
    expect(p.turn).toBe(5);
    expect(p.slot).toBe(it.slot);
    expect(p.bitsI).toHaveLength(4);
    expect(p.bitsR).toHaveLength(4);
    expect(() => buildWrongParityProof(it, { ...rv, slot: (rv.slot + 1) % 16 })).toThrow(/slots differ/);
  });
});

describe("wire serde", () => {
  test("SignedMove with ceremony round-trips byte-perfectly", () => {
    const pair = playersA();
    const m0 = buildMove(pair, 0, { kind: KIND_PLACE, cell: 3, size: 2 }, null);
    const m1 = buildMove(pair, 1, { kind: KIND_PLACE, cell: 8, size: 1 }, m0);
    const back = decodeMove(encodeMove(m1));
    expect(back.turn).toBe(m1.turn);
    expect(back.kind).toBe(m1.kind);
    expect(Buffer.from(back.boardAfter)).toEqual(Buffer.from(m1.boardAfter));
    expect(Buffer.from(back.reservesAfter)).toEqual(Buffer.from(m1.reservesAfter));
    expect(Buffer.from(back.prevHash)).toEqual(Buffer.from(m1.prevHash));
    expect(back.indexReveal!.slot).toBe(m1.indexReveal!.slot);
    expect(back.indexReveal!.bits).toEqual(m1.indexReveal!.bits);
    expect(back.randomReveal!.bits).toEqual(m1.randomReveal!.bits);
    expect(Buffer.from(back.randomReveal!.random)).toEqual(Buffer.from(m1.randomReveal!.random));
    for (let i = 0; i < m1.token.path.path.length; i++) {
      expect(back.token.path.path[i].sibling.field).toBe(m1.token.path.path[i].sibling.field);
    }
    expect(Buffer.from(hashSignedMove(back))).toEqual(Buffer.from(hashSignedMove(m1)));
  });
});
