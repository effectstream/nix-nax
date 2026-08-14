// Contract-only simulation tests for the SIMPLIFIED (teaching) arena — drive
// the compiled circuits in pure JS via @midnight-ntwrk/compact-runtime.
// Covers: createGame/joinGame lifecycle + input format, game isolation,
// chunked settle (one-time token verification, placement/stacking/removal/
// pass, reserves, mover alternation, stop-at-win, 128-turn draw), and
// claimResult (winner-only finalisation + mint, draw by either, double-claim
// rejection).
//
// The trust machinery of the advanced version (I/R trees, fraud proofs, the
// roll dispute, timeouts, challenge windows) is gone — but each settled move
// still reveals a one-time token verified under the mover's committed
// Merkle root, so the fixtures carry real token trees.

import { describe, test, expect } from "vitest";
import {
  createConstructorContext,
  createCircuitContext,
  type CircuitContext,
} from "@midnight-ntwrk/compact-runtime";

import { Contract, ledger, Status, Winner } from "../src/contract/managed/contract/index.js";
import { createWitnesses, createNixNaxPrivateState } from "../src/contract/witnesses.ts";
import { secretFor } from "../src/sdk/crypto/token-tree.ts";
import {
  playersA,
  playersC,
  playersD,
  playersE,
  packChunk,
  ZERO_BYTES32,
  ZERO_PATH_14,
  type TestPair,
  type ScriptMove,
} from "./helpers/fixtures.ts";
import { KIND_PLACE, KIND_REMOVE, KIND_PASS, MAX_TURNS, type Kind } from "../src/sdk/game/rules.ts";

const ZERO_KEY = new Uint8Array(32);
const CONTRACT_ADDR = "0".repeat(64);
const RECIP = { bytes: new Uint8Array(32).fill(7) }; // dummy ZswapCoinPublicKey

const P = (cell: number, size: number): ScriptMove => ({ kind: KIND_PLACE, cell, size });
const R = (cell: number): ScriptMove => ({ kind: KIND_REMOVE, cell, size: 0 });
const PASS: ScriptMove = { kind: KIND_PASS, cell: 0, size: 0 };

// X fills row 0 (cells 0,1,2,3) over turns 0,2,4,6 while O plays 4,5,6 — X
// wins by 4-in-a-row at turn 6. 7 moves total. (X uses its 3 smalls at 0,1,2
// and a size-1 at 3, since only 3 per size.)
const WIN_X: ScriptMove[] = [P(0, 0), P(4, 0), P(1, 0), P(5, 0), P(2, 0), P(6, 0), P(3, 1)];

// O wins the ↘ diagonal {0,5,10,15}: X plays row 3 minus the diagonal corner.
// (O's 4th diagonal piece is a size-1 — only 3 smalls per player.)
const WIN_O_DIAG: ScriptMove[] = [
  P(12, 0), P(0, 0), P(13, 0), P(5, 0), P(14, 0), P(10, 0), P(4, 1), P(15, 1),
];

// A 128-move draw: X places a small at cell 0; O removes it. Repeated 64
// times the board oscillates and never lines up.
const DRAW_128: ScriptMove[] = (() => {
  const moves: ScriptMove[] = [];
  for (let i = 0; i < MAX_TURNS / 2; i++) moves.push(P(0, 0), R(0));
  return moves;
})();

// ── Harness ─────────────────────────────────────────────────────────────────

function newCircuitCtx<PS>(contractState: any, privateState: PS, time?: number): CircuitContext<PS> {
  return createCircuitContext<PS>(
    CONTRACT_ADDR as any,
    ZERO_KEY as any,
    contractState,
    privateState,
    undefined,
    undefined,
    time,
  );
}

// Deploy the arena and open one game for the fixture pair. The private state
// (= localSecret witness) defaults to X's secret; pass another to act as O or
// as an outsider.
function setup(pair: TestPair, playerSecret?: Uint8Array) {
  const privateState = createNixNaxPrivateState(playerSecret ?? pair.x.secret);
  const contract = new Contract(createWitnesses() as any);

  const ctorCtx = createConstructorContext(privateState, ZERO_KEY as any);
  const deployed = contract.initialState(ctorCtx);

  let state = deployed.currentContractState;
  state = openGame(contract, state, privateState, pair);
  return { contract, privateState, state };
}

function openGame(contract: any, state: any, privateState: any, pair: TestPair) {
  let ctx = newCircuitCtx(state, privateState, 100);
  const created = (contract.impureCircuits as any).createGame(ctx, pair.gameId, pair.x.id, pair.x.token.root);
  ctx = newCircuitCtx(created.context.currentQueryContext.state, privateState, 110);
  const joined = (contract.impureCircuits as any).joinGame(ctx, pair.gameId, pair.o.id, pair.o.token.root);
  return joined.context.currentQueryContext.state;
}

// Settle a script of moves starting at baseTurn, auto-splitting into chunks of 8.
function settleChunk(
  contract: any,
  state: any,
  privateState: any,
  pair: TestPair,
  baseTurn: number,
  moves: ScriptMove[],
  opts: { time?: number } = {},
) {
  let cur = state;
  for (let off = 0; off < moves.length; off += 8) {
    const c = packChunk(pair, baseTurn + off, moves.slice(off, off + 8));
    const ctx = newCircuitCtx(cur, privateState, (opts.time ?? 1000) + off);
    const res = contract.impureCircuits.settle(
      ctx, pair.gameId, c.nMoves, c.kinds, c.cells, c.sizes, c.secrets, c.paths,
    );
    cur = res.context.currentQueryContext.state;
  }
  return cur;
}

const led = (state: any) => ledger(state);
const dynOf = (l: any, pair: TestPair) => l.gameState.lookup(pair.gameId);
const keysOf = (l: any, pair: TestPair) => l.gameKeys.lookup(pair.gameId);
const topAt = (l: any, pair: TestPair, cell: number) => {
  const inner = l.tops.lookup(pair.gameId);
  return inner.member(BigInt(cell)) ? Number(inner.lookup(BigInt(cell))) : 0;
};
const boardAt = (l: any, pair: TestPair, k: number) => {
  const inner = l.boards.lookup(pair.gameId);
  return inner.member(BigInt(k)) ? Number(inner.lookup(BigInt(k))) : 0;
};
const reserveOf = (l: any, pair: TestPair, mark: number, size: number) =>
  Number(l.reserves.lookup(pair.gameId).lookup(BigInt(mark * 4 + size)));
const logAt = (l: any, pair: TestPair, turn: number) => {
  const inner = l.actionLogs.lookup(pair.gameId);
  return inner.member(BigInt(turn)) ? Number(inner.lookup(BigInt(turn))) : null;
};

// ── Lifecycle ───────────────────────────────────────────────────────────────

describe("createGame / joinGame", () => {
  test("game opens with both ids + roots; reserves 3 each; empty board; X to move", () => {
    const pair = playersA();
    const { state } = setup(pair);
    const l = led(state);
    const k = keysOf(l, pair);
    expect(Buffer.from(k.idX)).toEqual(Buffer.from(pair.x.id));
    expect(Buffer.from(k.idO)).toEqual(Buffer.from(pair.o.id));
    expect(k.rootX.field).toBe(pair.x.token.root.field);
    expect(k.rootO.field).toBe(pair.o.token.root.field);
    const d = dynOf(l, pair);
    expect(d.status).toBe(Status.inProgress);
    expect(d.winner).toBe(Winner.none);
    expect(Number(d.committedTurns)).toBe(0);
    expect(Number(d.turnMark)).toBe(1);
    for (let c = 0; c < 16; c++) expect(topAt(l, pair, c)).toBe(0);
    for (const m of [1, 2]) for (let s = 0; s < 4; s++) expect(reserveOf(l, pair, m, s)).toBe(3);
  });

  test("input format: zero identity / zero root / identity collision rejected", () => {
    const pair = playersA();
    const other = playersD(); // unused gameId on this contract
    const { contract, privateState, state } = setup(pair);
    const ZERO32 = new Uint8Array(32);
    let ctx = newCircuitCtx(state, privateState, 200);
    expect(() =>
      (contract.impureCircuits as any).createGame(ctx, other.gameId, ZERO32, other.x.token.root),
    ).toThrow(/identity must not be zero/);
    ctx = newCircuitCtx(state, privateState, 200);
    expect(() =>
      (contract.impureCircuits as any).createGame(ctx, other.gameId, other.x.id, { field: 0n }),
    ).toThrow(/token root must not be zero/);
    ctx = newCircuitCtx(state, privateState, 200);
    const created = (contract.impureCircuits as any).createGame(ctx, other.gameId, other.x.id, other.x.token.root);
    ctx = newCircuitCtx(created.context.currentQueryContext.state, privateState, 210);
    expect(() =>
      (contract.impureCircuits as any).joinGame(ctx, other.gameId, ZERO32, other.o.token.root),
    ).toThrow(/identity must not be zero/);
    ctx = newCircuitCtx(created.context.currentQueryContext.state, privateState, 210);
    expect(() =>
      (contract.impureCircuits as any).joinGame(ctx, other.gameId, other.x.id, other.o.token.root),
    ).toThrow(/joiner identity must differ/);
    ctx = newCircuitCtx(created.context.currentQueryContext.state, privateState, 210);
    expect(() =>
      (contract.impureCircuits as any).joinGame(ctx, other.gameId, other.o.id, { field: 0n }),
    ).toThrow(/token root must not be zero/);
  });

  test("duplicate gameId / double join / unknown game rejected", () => {
    const pair = playersA();
    const ghost = playersE();
    const { contract, privateState, state } = setup(pair);
    let ctx = newCircuitCtx(state, privateState, 200);
    expect(() =>
      (contract.impureCircuits as any).createGame(ctx, pair.gameId, pair.x.id, pair.x.token.root),
    ).toThrow(/gameId already exists/);
    ctx = newCircuitCtx(state, privateState, 200);
    expect(() =>
      (contract.impureCircuits as any).joinGame(ctx, pair.gameId, ghost.o.id, ghost.o.token.root),
    ).toThrow(/game already open/);
    ctx = newCircuitCtx(state, privateState, 200);
    expect(() =>
      (contract.impureCircuits as any).joinGame(ctx, ghost.gameId, ghost.o.id, ghost.o.token.root),
    ).toThrow(/no such game/);
  });

  test("settle before join rejected; two games coexist independently", () => {
    const pairWin = playersC();
    const pairOther = playersA();
    const { contract, privateState, state } = setup(pairWin);

    // A half-open game cannot settle.
    const half = playersD();
    let ctx = newCircuitCtx(state, privateState, 300);
    const created = (contract.impureCircuits as any).createGame(ctx, half.gameId, half.x.id, half.x.token.root);
    const c = packChunk(half, 0, [P(0, 0)]);
    ctx = newCircuitCtx(created.context.currentQueryContext.state, privateState, 310);
    expect(() =>
      contract.impureCircuits.settle(ctx, half.gameId, c.nMoves, c.kinds, c.cells, c.sizes, c.secrets, c.paths),
    ).toThrow(/not in progress/);

    // Open a SECOND game on the same contract; settle the first to an X win.
    const state2 = openGame(contract, state, privateState, pairOther);
    const state3 = settleChunk(contract, state2, privateState, pairWin, 0, WIN_X);
    const l = led(state3);
    expect(dynOf(l, pairWin).winner).toBe(Winner.x);
    expect(Number(dynOf(l, pairWin).committedTurns)).toBe(7);
    expect(dynOf(l, pairOther).winner).toBe(Winner.none);
    expect(Number(dynOf(l, pairOther).committedTurns)).toBe(0);
    for (let c2 = 0; c2 < 16; c2++) expect(topAt(l, pairOther, c2)).toBe(0);

    // And the second game can still play.
    const state4 = settleChunk(contract, state3, privateState, pairOther, 0, [P(9, 1)], { time: 1500 });
    expect(Number(dynOf(led(state4), pairOther).committedTurns)).toBe(1);
  });
});

// ── Settle: one-time tokens ─────────────────────────────────────────────────

describe("settle (one-time tokens)", () => {
  test("a move with a wrong token secret is rejected", () => {
    const pair = playersC();
    const { contract, privateState, state } = setup(pair);
    const c = packChunk(pair, 0, [P(0, 0)]);
    c.secrets[0] = ZERO_BYTES32; // valid path, wrong preimage secret
    const ctx = newCircuitCtx(state, privateState, 400);
    expect(() =>
      contract.impureCircuits.settle(ctx, pair.gameId, c.nMoves, c.kinds, c.cells, c.sizes, c.secrets, c.paths),
    ).toThrow(/invalid one-time token/);
  });

  test("a token from the WRONG player's tree is rejected", () => {
    const pair = playersC();
    const { contract, privateState, state } = setup(pair);
    // Turn 0 is X's move — reveal O's (valid) token for the same action instead.
    const c = packChunk(pair, 0, [P(0, 0)]);
    c.secrets[0] = secretFor(pair.o.token, 0, KIND_PLACE, 0, 0);
    c.paths[0] = pair.o.token.pathFor(0, KIND_PLACE, 0, 0);
    const ctx = newCircuitCtx(state, privateState, 400);
    expect(() =>
      contract.impureCircuits.settle(ctx, pair.gameId, c.nMoves, c.kinds, c.cells, c.sizes, c.secrets, c.paths),
    ).toThrow(/invalid one-time token/);
  });

  test("a token for a DIFFERENT turn/action is rejected", () => {
    const pair = playersC();
    const { contract, privateState, state } = setup(pair);
    // Claim P(0,0) at turn 0 but reveal X's token for turn 2's P(0,0).
    const c = packChunk(pair, 0, [P(0, 0)]);
    c.secrets[0] = secretFor(pair.x.token, 2, KIND_PLACE, 0, 0);
    c.paths[0] = pair.x.token.pathFor(2, KIND_PLACE, 0, 0);
    const ctx = newCircuitCtx(state, privateState, 400);
    expect(() =>
      contract.impureCircuits.settle(ctx, pair.gameId, c.nMoves, c.kinds, c.cells, c.sizes, c.secrets, c.paths),
    ).toThrow(/invalid one-time token/);
  });
});

// ── Settle: happy paths ─────────────────────────────────────────────────────

describe("settle (placement + win)", () => {
  test("X wins by filling a row in one chunk", () => {
    const pair = playersC();
    const { contract, privateState, state } = setup(pair);
    const s2 = settleChunk(contract, state, privateState, pair, 0, WIN_X);
    const l = led(s2);
    const d = dynOf(l, pair);
    expect(d.winner).toBe(Winner.x);
    expect(Number(d.committedTurns)).toBe(7);
    expect(topAt(l, pair, 0)).toBe(1);
    expect(topAt(l, pair, 4)).toBe(2);
    expect(reserveOf(l, pair, 1, 0)).toBe(0); // X used all 3 smalls (cells 0,1,2)
    expect(reserveOf(l, pair, 1, 1)).toBe(2); // ...plus one size-1 (cell 3)
    expect(reserveOf(l, pair, 2, 0)).toBe(0); // O used all 3 smalls (cells 4,5,6)
    // actionLog keeps the shared packed format (place ⇒ class bit set).
    expect(logAt(l, pair, 0)).toBe(256 + KIND_PLACE * 64 + 0 * 16 + 0);
    expect(logAt(l, pair, 6)).toBe(256 + KIND_PLACE * 64 + 1 * 16 + 3);
  });

  test("O wins on the ↘ diagonal", () => {
    const pair = playersC();
    const { contract, privateState, state } = setup(pair);
    const s2 = settleChunk(contract, state, privateState, pair, 0, WIN_O_DIAG);
    const d = dynOf(led(s2), pair);
    expect(d.winner).toBe(Winner.o);
    expect(Number(d.committedTurns)).toBe(8);
  });

  test("chunked extension: mover alternation carries across chunks", () => {
    const pair = playersC();
    const { contract, privateState, state } = setup(pair);
    // 3 moves land: X,O,X — next mover is O (turnMark 2).
    const s1 = settleChunk(contract, state, privateState, pair, 0, WIN_X.slice(0, 3));
    expect(Number(dynOf(led(s1), pair).committedTurns)).toBe(3);
    expect(Number(dynOf(led(s1), pair).turnMark)).toBe(2);
    // The remaining 4 moves continue with O and X wins at the end.
    const s2 = settleChunk(contract, s1, privateState, pair, 3, WIN_X.slice(3), { time: 1100 });
    const d = dynOf(led(s2), pair);
    expect(Number(d.committedTurns)).toBe(7);
    expect(d.winner).toBe(Winner.x);
  });

  test("moves after a win in the same chunk are rejected", () => {
    const pair = playersC();
    const { contract, privateState, state } = setup(pair);
    const withExtra = [...WIN_X, P(8, 0)]; // 8 moves, win at index 6
    expect(() =>
      settleChunk(contract, state, privateState, pair, 0, withExtra),
    ).toThrow(/moves after game end/);
  });

  test("settle on a decided game rejected; empty chunk rejected", () => {
    const pair = playersC();
    const { contract, privateState, state } = setup(pair);
    // Empty chunk on a live game — rejected before anything else.
    const c = packChunk(pair, 0, []);
    let ctx = newCircuitCtx(state, privateState, 900);
    expect(() =>
      contract.impureCircuits.settle(ctx, pair.gameId, 0n, c.kinds, c.cells, c.sizes, c.secrets, c.paths),
    ).toThrow(/empty chunk/);
    const s1 = settleChunk(contract, state, privateState, pair, 0, WIN_X);
    expect(() =>
      settleChunk(contract, s1, privateState, pair, 7, [P(8, 0)], { time: 1100 }),
    ).toThrow(/already decided/);
  });

  test("turn 0 must be a placement; kind/cell/size ranges enforced", () => {
    const pair = playersC();
    const { contract, privateState, state } = setup(pair);
    expect(() =>
      settleChunk(contract, state, privateState, pair, 0, [R(0)]),
    ).toThrow(/turn 0 must be a placement/);
    const bad = (moves: ScriptMove[], pattern: RegExp) => {
      // Range asserts fire BEFORE token verification — dummy tokens suffice.
      const c = packChunk(pair, 0, []);
      const m = moves[0];
      c.kinds[0] = BigInt(m.kind); c.cells[0] = BigInt(m.cell); c.sizes[0] = BigInt(m.size);
      const ctx = newCircuitCtx(state, privateState, 950);
      expect(() =>
        contract.impureCircuits.settle(ctx, pair.gameId, 1n, c.kinds, c.cells, c.sizes, c.secrets, c.paths),
      ).toThrow(pattern);
    };
    bad([{ kind: 5 as Kind, cell: 0, size: 0 }], /unknown action kind/);
    bad([P(16, 0)], /cell out of range/);
    bad([P(0, 4)], /size out of range/);
  });
});

// ── Settle: stacking / removal / pass rules ─────────────────────────────────

describe("settle (stacking)", () => {
  test("cover opponent's smaller piece; tops update", () => {
    const pair = playersA();
    const { contract, privateState, state } = setup(pair);
    const s1 = settleChunk(contract, state, privateState, pair, 0, [P(2, 0), P(2, 1)]);
    const l = led(s1);
    expect(topAt(l, pair, 2)).toBe(2);
    expect(boardAt(l, pair, 2 * 4 + 0)).toBe(1);
    expect(boardAt(l, pair, 2 * 4 + 1)).toBe(2);
  });

  test("same-size / smaller onto occupied rejected", () => {
    const pair = playersA();
    const { contract, privateState, state } = setup(pair);
    expect(() =>
      settleChunk(contract, state, privateState, pair, 0, [P(2, 1), P(2, 1)]),
    ).toThrow(/piece of that size or larger/);
    expect(() =>
      settleChunk(contract, state, privateState, pair, 0, [P(2, 0), P(2, 0)]),
    ).toThrow(/cell occupied at target size/);
    expect(() =>
      settleChunk(contract, state, privateState, pair, 0, [P(2, 3), P(2, 0)]),
    ).toThrow(/larger piece occupies this cell/);
  });

  test("reserve exhaustion: a 4th piece of one size is rejected", () => {
    const pair = playersA();
    const { contract, privateState, state } = setup(pair);
    // X places smalls at 0, 2, 4 (3 = all of them), O at 8, 9, 10; X's 4th small fails.
    const moves = [P(0, 0), P(8, 0), P(2, 0), P(9, 0), P(4, 0), P(10, 0), P(6, 0)];
    expect(() =>
      settleChunk(contract, state, privateState, pair, 0, moves),
    ).toThrow(/no piece of that size left in reserve/);
  });

  test("remove reveals what was beneath and returns the piece to its owner", () => {
    const pair = playersA();
    const { contract, privateState, state } = setup(pair);
    // X small at 2; O covers with size 1; X removes the O cover — X's small
    // resurfaces and O's piece goes back to O's reserve.
    const s1 = settleChunk(contract, state, privateState, pair, 0, [P(2, 0), P(2, 1), R(2)]);
    const l = led(s1);
    expect(topAt(l, pair, 2)).toBe(1);
    expect(boardAt(l, pair, 2 * 4 + 1)).toBe(0);
    expect(reserveOf(l, pair, 2, 1)).toBe(3); // O's size-1 back to 3
    expect(Number(dynOf(l, pair).committedTurns)).toBe(3);
  });

  test("remove on an empty cell / non-canonical remove rejected", () => {
    const pair = playersA();
    const { contract, privateState, state } = setup(pair);
    expect(() =>
      settleChunk(contract, state, privateState, pair, 0, [P(0, 0), R(5)]),
    ).toThrow(/cell is empty/);
    // A remove token always has canonical size 0, so a size!=0 remove cannot
    // even present a valid token — the token assert fires first.
    const c = packChunk(pair, 0, [P(0, 0)]);
    c.kinds[1] = BigInt(KIND_REMOVE); c.cells[1] = 0n; c.sizes[1] = 1n;
    c.secrets[1] = secretFor(pair.o.token, 1, KIND_REMOVE, 0, 0);
    c.paths[1] = pair.o.token.pathFor(1, KIND_REMOVE, 0, 0);
    const ctx = newCircuitCtx(state, privateState, 960);
    expect(() =>
      contract.impureCircuits.settle(ctx, pair.gameId, 2n, c.kinds, c.cells, c.sizes, c.secrets, c.paths),
    ).toThrow(/invalid one-time token/);
  });

  test("pass only when nothing is removable; canonical form enforced", () => {
    const pair = playersA();
    const { contract, privateState, state } = setup(pair);
    // Turn 0: X places. Turn 1: O passes — ILLEGAL, X's piece is removable.
    expect(() =>
      settleChunk(contract, state, privateState, pair, 0, [P(0, 0), PASS]),
    ).toThrow(/pass not allowed/);
    // A pass is legal when the board is empty: X places at 0, O removes it,
    // then X (empty board again) passes.
    const s1 = settleChunk(contract, state, privateState, pair, 0, [P(0, 0), R(0), PASS]);
    expect(Number(dynOf(led(s1), pair).committedTurns)).toBe(3);
  });

  test("a removal revealing the opponent's line wins for the opponent", () => {
    const pair = playersA();
    const { contract, privateState, state } = setup(pair);
    // X hides a small at 3 under O's size-1 cover, then fills 0, 1 (smalls)
    // and 2 (size-1). When O removes its own cover at 3, X's row 0 is revealed:
    // the mover (O) has no line, so the win goes to X.
    const script = [
      P(3, 0), P(3, 1),  // X small at 3; O covers with size-1
      P(0, 0), P(4, 0),
      P(1, 0), P(5, 0),
      P(2, 1), R(3),     // O removes its own cover — X's row 0 completes
    ];
    const s1 = settleChunk(contract, state, privateState, pair, 0, script);
    const d = dynOf(led(s1), pair);
    expect(d.winner).toBe(Winner.x);
    expect(Number(d.committedTurns)).toBe(8);
  });
});

// ── Draw at the 128-turn cap ────────────────────────────────────────────────

describe("settle (draw)", () => {
  test("128 turns with no line ends in a draw; further settles rejected", () => {
    const pair = playersE();
    const { contract, privateState, state } = setup(pair);
    const s1 = settleChunk(contract, state, privateState, pair, 0, DRAW_128);
    const d = dynOf(led(s1), pair);
    expect(d.winner).toBe(Winner.draw);
    expect(Number(d.committedTurns)).toBe(128);
    // Past-cap turns have no tokens (trees stop at turn 127) — but the
    // "already decided" assert fires before token verification, so a dummy
    // chunk is enough to probe it.
    const c = packChunk(pair, 0, []);
    c.kinds[0] = BigInt(KIND_PLACE); c.cells[0] = 1n;
    const ctx = newCircuitCtx(s1, privateState, 2000);
    expect(() =>
      contract.impureCircuits.settle(ctx, pair.gameId, 1n, c.kinds, c.cells, c.sizes, c.secrets, c.paths),
    ).toThrow(/already decided/);
  });

  test("the 129th move is rejected even without a draw recorded yet", () => {
    const pair = playersE();
    const { contract, privateState, state } = setup(pair);
    const s1 = settleChunk(contract, state, privateState, pair, 0, DRAW_128.slice(0, 126));
    expect(Number(dynOf(led(s1), pair).committedTurns)).toBe(126);
    // A 3-move chunk would cross the 128 cap; the cap assert fires before any
    // token verification, so only the first two moves carry real tokens.
    const c = packChunk(pair, 126, [P(0, 0), R(0)]);
    c.kinds[2] = BigInt(KIND_PLACE);
    const ctx = newCircuitCtx(s1, privateState, 2000);
    expect(() =>
      contract.impureCircuits.settle(ctx, pair.gameId, 3n, c.kinds, c.cells, c.sizes, c.secrets, c.paths),
    ).toThrow(/exceeds max turns/);
  });
});

// ── claimResult ─────────────────────────────────────────────────────────────

describe("claimResult", () => {
  test("winner finalises + mints immediately (no waiting window)", () => {
    const pair = playersC();
    const { contract, privateState, state } = setup(pair); // private state = X (winner)
    const s1 = settleChunk(contract, state, privateState, pair, 0, WIN_X);
    const ctx = newCircuitCtx(s1, privateState, 1001); // right after the settle
    const fin = (contract.impureCircuits as any).claimResult(ctx, pair.gameId, RECIP);
    const d = dynOf(led(fin.context.currentQueryContext.state), pair);
    expect(d.status).toBe(Status.settled);
    expect(d.winner).toBe(Winner.x);
  });

  test("the loser cannot finalise a decided game", () => {
    const pair = playersC();
    const { contract, privateState, state } = setup(pair, pair.o.secret); // O = loser
    const s1 = settleChunk(contract, state, privateState, pair, 0, WIN_X);
    const ctx = newCircuitCtx(s1, privateState, 1001);
    expect(() => (contract.impureCircuits as any).claimResult(ctx, pair.gameId, RECIP))
      .toThrow(/only the winner/);
  });

  test("an outsider (unregistered secret) cannot finalise anything", () => {
    const pair = playersC();
    // NB: a fixture pair's X secret is seed-shared across pairs (only gameIds
    // differ), so "another pair's player" is NOT an outsider — use a fresh
    // arbitrary secret instead.
    const outsiderSecret = new Uint8Array(32).fill(0x42);
    const { contract, privateState, state } = setup(pair, outsiderSecret);
    const s1 = settleChunk(contract, state, privateState, pair, 0, WIN_X);
    const ctx = newCircuitCtx(s1, privateState, 1001);
    expect(() => (contract.impureCircuits as any).claimResult(ctx, pair.gameId, RECIP))
      .toThrow(/must prove knowledge of a registered player secret/);
  });

  test("no decided outcome -> rejected; double claim -> rejected", () => {
    const pair = playersC();
    const { contract, privateState, state } = setup(pair);
    let ctx = newCircuitCtx(state, privateState, 500);
    expect(() => (contract.impureCircuits as any).claimResult(ctx, pair.gameId, RECIP))
      .toThrow(/no decided outcome/);
    const s1 = settleChunk(contract, state, privateState, pair, 0, WIN_X);
    ctx = newCircuitCtx(s1, privateState, 1001);
    const fin = (contract.impureCircuits as any).claimResult(ctx, pair.gameId, RECIP);
    ctx = newCircuitCtx(fin.context.currentQueryContext.state, privateState, 1002);
    expect(() => (contract.impureCircuits as any).claimResult(ctx, pair.gameId, RECIP))
      .toThrow(/already finalised/);
  });

  test("a draw is finalisable by either player (no mint)", () => {
    const pair = playersE();
    const { contract, privateState, state } = setup(pair, pair.o.secret); // O finalises
    const s1 = settleChunk(contract, state, privateState, pair, 0, DRAW_128);
    const ctx = newCircuitCtx(s1, privateState, 2001);
    const fin = (contract.impureCircuits as any).claimResult(ctx, pair.gameId, RECIP);
    const d = dynOf(led(fin.context.currentQueryContext.state), pair);
    expect(d.status).toBe(Status.settled);
    expect(d.winner).toBe(Winner.draw);
  });

  test("recipient must not be the zero key (no accidental burn)", () => {
    const pair = playersC();
    const { contract, privateState, state } = setup(pair);
    const s1 = settleChunk(contract, state, privateState, pair, 0, WIN_X);
    const ctx = newCircuitCtx(s1, privateState, 1001);
    expect(() =>
      (contract.impureCircuits as any).claimResult(ctx, pair.gameId, { bytes: new Uint8Array(32) }),
    ).toThrow(/recipient must not be the zero key/);
  });
});
