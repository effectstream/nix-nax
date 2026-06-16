// Contract-only simulation tests for the multi-game ARENA — drive the
// compiled circuits in pure JS via @midnight-ntwrk/compact-runtime.
// Covers: createGame/joinGame lifecycle, game isolation, chunked settle
// (placement/stacking/removal/pass, reserves, stop-at-win, class
// consistency), the wrong-parity (4-bit roll) fraud proof, the three
// equivocation proofs, and timeout.

import { describe, test, expect } from "vitest";
import {
  createConstructorContext,
  createCircuitContext,
  type CircuitContext,
} from "@midnight-ntwrk/compact-runtime";

import { Contract, ledger, Status, Winner } from "../src/contract/managed/contract/index.js";
import { createWitnesses, createTicTacToePrivateState } from "../src/contract/witnesses.ts";
import {
  playersA,
  playersB,
  playersC,
  playersD,
  packChunk,
  intentFor,
  revealFor,
  type TestPair,
  type ScriptMove,
} from "./helpers/fixtures.ts";
import { KIND_PLACE, KIND_REMOVE, KIND_PASS } from "../src/sdk/game/rules.ts";

const ZERO_KEY = new Uint8Array(32);
const CONTRACT_ADDR = "0".repeat(64);

const P = (cell: number, size: number): ScriptMove => ({ kind: KIND_PLACE, cell, size });
const R = (cell: number): ScriptMove => ({ kind: KIND_REMOVE, cell, size: 0 });
const PASS: ScriptMove = { kind: KIND_PASS, cell: 0, size: 0 };

// X fills row 0 (cells 0,1,2,3) over turns 0,2,4,6 while O plays 4,5,6 — X
// wins by 4-in-a-row at turn 6. All-place ⇒ use playersC. 7 moves total.
// (X uses its 3 smalls at 0,1,2 and a size-1 at 3, since only 3 per size.)
const WIN_X: ScriptMove[] = [P(0, 0), P(4, 0), P(1, 0), P(5, 0), P(2, 0), P(6, 0), P(3, 1)];

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

// Deploy the (stateless) arena and open one game for the fixture pair.
function setup(pair: TestPair, playerSecret?: Uint8Array) {
  const privateState = createTicTacToePrivateState(playerSecret ?? pair.x.secret);
  const contract = new Contract(createWitnesses() as any);

  const ctorCtx = createConstructorContext(privateState, ZERO_KEY as any);
  const deployed = contract.initialState(ctorCtx);

  let state = deployed.currentContractState;
  state = openGame(contract, state, privateState, pair);
  return { contract, privateState, state };
}

function openGame(contract: any, state: any, privateState: any, pair: TestPair) {
  let ctx = newCircuitCtx(state, privateState, 100);
  const created = (contract.impureCircuits as any).createGame(
    ctx, pair.gameId, pair.x.id, pair.x.token.root, pair.x.index.root, pair.x.random.root,
  );
  ctx = newCircuitCtx(created.context.currentQueryContext.state, privateState, 110);
  const joined = (contract.impureCircuits as any).joinGame(
    ctx, pair.gameId, pair.o.id, pair.o.token.root, pair.o.index.root, pair.o.random.root,
  );
  return joined.context.currentQueryContext.state;
}

// Settle a script of moves, auto-splitting into chunks of 8.
function settleChunk(
  contract: any,
  state: any,
  privateState: any,
  pair: TestPair,
  baseTurn: number,
  moves: ScriptMove[],
  opts: { time?: number; until?: bigint } = {},
) {
  let cur = state;
  if (moves.length === 0) {
    const c = packChunk(pair, baseTurn, []);
    const ctx = newCircuitCtx(cur, privateState, opts.time ?? 1000);
    contract.impureCircuits.settle(
      ctx, pair.gameId, c.nMoves, c.parities, c.kinds, c.cells, c.sizes, c.secrets, c.paths, opts.until ?? 5000n,
    );
    return cur;
  }
  for (let off = 0; off < moves.length; off += 8) {
    const c = packChunk(pair, baseTurn + off, moves.slice(off, off + 8));
    const ctx = newCircuitCtx(cur, privateState, (opts.time ?? 1000) + off);
    const res = contract.impureCircuits.settle(
      ctx, pair.gameId, c.nMoves, c.parities, c.kinds, c.cells, c.sizes, c.secrets, c.paths, opts.until ?? 5000n,
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

// ── Lifecycle ───────────────────────────────────────────────────────────────

describe("createGame / joinGame", () => {
  test("game opens with both ids + six roots; reserves 3 each; empty board", () => {
    const pair = playersA();
    const { state } = setup(pair);
    const l = led(state);
    const k = keysOf(l, pair);
    expect(Buffer.from(k.idX)).toEqual(Buffer.from(pair.x.id));
    expect(Buffer.from(k.idO)).toEqual(Buffer.from(pair.o.id));
    expect(k.rootX.field).toBe(pair.x.token.root.field);
    expect(k.rootO.field).toBe(pair.o.token.root.field);
    expect(k.rootIdxX.field).toBe(pair.x.index.root.field);
    expect(k.rootIdxO.field).toBe(pair.o.index.root.field);
    expect(k.rootRndX.field).toBe(pair.x.random.root.field);
    expect(k.rootRndO.field).toBe(pair.o.random.root.field);
    const d = dynOf(l, pair);
    expect(d.status).toBe(Status.inProgress);
    expect(d.winner).toBe(Winner.none);
    expect(Number(d.committedTurns)).toBe(0);
    for (let c = 0; c < 16; c++) expect(topAt(l, pair, c)).toBe(0);
    for (const m of [1, 2]) for (let s = 0; s < 4; s++) expect(reserveOf(l, pair, m, s)).toBe(3);
  });

  test("duplicate gameId rejected; two games coexist independently", () => {
    const pairWin = playersC();
    const pairOther = playersA();
    const { contract, privateState, state } = setup(pairWin);

    // Duplicate create -> rejected.
    const ctx = newCircuitCtx(state, privateState, 200);
    expect(() =>
      (contract.impureCircuits as any).createGame(
        ctx, pairWin.gameId, pairWin.x.id, pairWin.x.token.root, pairWin.x.index.root, pairWin.x.random.root,
      ),
    ).toThrow(/gameId already exists/);

    // Open a SECOND game on the same contract.
    const state2 = openGame(contract, state, privateState, pairOther);

    // Settle the first game to an X win; the second stays untouched.
    const state3 = settleChunk(contract, state2, privateState, pairWin, 0, WIN_X);
    const l = led(state3);
    expect(dynOf(l, pairWin).winner).toBe(Winner.x);
    expect(Number(dynOf(l, pairWin).committedTurns)).toBe(7);
    expect(dynOf(l, pairOther).winner).toBe(Winner.none);
    expect(Number(dynOf(l, pairOther).committedTurns)).toBe(0);
    for (let c = 0; c < 16; c++) expect(topAt(l, pairOther, c)).toBe(0);

    // And the second game can still play.
    const state4 = settleChunk(contract, state3, privateState, pairOther, 0, [P(9, 1)], { time: 1500 });
    expect(Number(dynOf(led(state4), pairOther).committedTurns)).toBe(1);
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
    expect(d.hasChallenge).toBe(true);
    expect(topAt(l, pair, 0)).toBe(1);
    expect(topAt(l, pair, 4)).toBe(2);
    expect(reserveOf(l, pair, 1, 0)).toBe(0); // X used all 3 smalls (cells 0,1,2)
    expect(reserveOf(l, pair, 1, 1)).toBe(2); // ...plus one size-1 (cell 3)
    expect(reserveOf(l, pair, 2, 0)).toBe(0); // O used all 3 smalls (cells 4,5,6)
  });

  test("chunked extension: settle 3 then 4 more moves", () => {
    const pair = playersC();
    const { contract, privateState, state } = setup(pair);
    const s1 = settleChunk(contract, state, privateState, pair, 0, WIN_X.slice(0, 3));
    expect(Number(dynOf(led(s1), pair).committedTurns)).toBe(3);
    expect(Number(dynOf(led(s1), pair).turnMark)).toBe(2);
    const s2 = settleChunk(contract, s1, privateState, pair, 3, WIN_X.slice(3), { time: 1100, until: 5500n });
    const d = dynOf(led(s2), pair);
    expect(Number(d.committedTurns)).toBe(7);
    expect(d.winner).toBe(Winner.x);
  });

  test("claimResult finalises after the window", () => {
    const pair = playersC();
    const { contract, privateState, state } = setup(pair);
    const s1 = settleChunk(contract, state, privateState, pair, 0, WIN_X, { until: 1500n });
    const ctx = newCircuitCtx(s1, privateState, 2000);
    const fin = (contract.impureCircuits as any).claimResult(ctx, pair.gameId);
    const d = dynOf(led(fin.context.currentQueryContext.state), pair);
    expect(d.status).toBe(Status.settled);
    expect(d.winner).toBe(Winner.x);
  });
});

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

  test("same-size cover rejected", () => {
    const pair = playersA();
    const { contract, privateState, state } = setup(pair);
    expect(() =>
      settleChunk(contract, state, privateState, pair, 0, [P(2, 1), P(2, 1)]),
    ).toThrow(/piece of that size or larger/);
  });

  test("small onto occupied layer rejected", () => {
    const pair = playersA();
    const { contract, privateState, state } = setup(pair);
    expect(() =>
      settleChunk(contract, state, privateState, pair, 0, [P(2, 0), P(2, 0)]),
    ).toThrow(/cell occupied at target size/);
  });

  test("cannot place under a larger piece", () => {
    const pair = playersA();
    const { contract, privateState, state } = setup(pair);
    expect(() =>
      settleChunk(contract, state, privateState, pair, 0, [P(2, 3), P(2, 0)]),
    ).toThrow(/larger piece occupies this cell/);
  });
});

describe("settle (removal)", () => {
  test("remove returns the piece to its owner and reveals beneath", () => {
    const pair = playersA();
    const { contract, privateState, state } = setup(pair);
    const s1 = settleChunk(contract, state, privateState, pair, 0,
      [P(2, 0), P(2, 1), P(0, 0), P(15, 0), P(1, 0), R(1)]);
    const l = led(s1);
    const d = dynOf(l, pair);
    expect(d.winner).toBe(Winner.none);
    expect(Number(d.committedTurns)).toBe(6);
    expect(topAt(l, pair, 1)).toBe(0);
    expect(reserveOf(l, pair, 1, 0)).toBe(1);
    expect(topAt(l, pair, 2)).toBe(2);
  });

  test("removing your own piece is rejected", () => {
    const pair = playersA();
    const { contract, privateState, state } = setup(pair);
    expect(() =>
      settleChunk(contract, state, privateState, pair, 0,
        [P(2, 0), P(4, 0), P(0, 0), P(15, 0), P(5, 0), R(4)]),
    ).toThrow(/visible piece is not the opponent's/);
  });

  test("pass while a removal exists is rejected", () => {
    const pair = playersA();
    const { contract, privateState, state } = setup(pair);
    expect(() =>
      settleChunk(contract, state, privateState, pair, 0,
        [P(2, 0), P(4, 0), P(0, 0), P(15, 0), P(5, 0), PASS]),
    ).toThrow(/pass not allowed/);
  });
});

describe("settle (pass + removal-reveal win, schedule B)", () => {
  test("forced pass on an empty board is accepted", () => {
    const pair = playersB();
    const { contract, privateState, state } = setup(pair);
    const s1 = settleChunk(contract, state, privateState, pair, 0, [P(0, 0), R(0), PASS]);
    const l = led(s1);
    expect(Number(dynOf(l, pair).committedTurns)).toBe(3);
    expect(dynOf(l, pair).winner).toBe(Winner.none);
    expect(reserveOf(l, pair, 1, 0)).toBe(3);
  });

  test("removing a covering piece reveals a winning line (mover precedence)", () => {
    const pair = playersD();
    const { contract, privateState, state } = setup(pair);
    // X builds row 0, but O covers cell 2 (t5); at t8 (X's remove turn) X
    // removes the cover, revealing X at c2 → row 0 complete → X wins by reveal.
    const moves = [
      P(0, 0), P(5, 0), P(1, 0), P(6, 0), P(2, 0), P(2, 1), P(3, 1), P(7, 0), R(2),
    ];
    const s1 = settleChunk(contract, state, privateState, pair, 0, moves);
    const l = led(s1);
    const d = dynOf(l, pair);
    expect(d.winner).toBe(Winner.x);
    expect(Number(d.committedTurns)).toBe(9);
    expect(topAt(l, pair, 2)).toBe(1);        // reverted to X's piece
    expect(reserveOf(l, pair, 2, 1)).toBe(3); // O's covering size-1 returned
  });
});

describe("settle (stop-at-win + guards)", () => {
  test("moves after a win are rejected (remove-the-winning-piece attack)", () => {
    const pair = playersC();
    const { contract, privateState, state } = setup(pair);
    expect(() =>
      settleChunk(contract, state, privateState, pair, 0, [...WIN_X, R(2)]),
    ).toThrow(/moves after game end/);
  });

  test("settle after a recorded win is rejected", () => {
    const pair = playersC();
    const { contract, privateState, state } = setup(pair);
    const s1 = settleChunk(contract, state, privateState, pair, 0, WIN_X);
    expect(() =>
      settleChunk(contract, s1, privateState, pair, 7, [R(2)], { time: 1100 }),
    ).toThrow(/game already decided/);
  });

  test("turn 0 must be a placement", () => {
    const pair = playersA();
    const { contract, privateState, state } = setup(pair);
    expect(() =>
      settleChunk(contract, state, privateState, pair, 0, [{ kind: KIND_REMOVE, cell: 0, size: 0, lieParity: 0 }]),
    ).toThrow(/turn 0 must be a placement/);
  });

  test("kind inconsistent with claimed class is rejected", () => {
    const pair = playersA();
    const { contract, privateState, state } = setup(pair);
    expect(() =>
      settleChunk(contract, state, privateState, pair, 0, [P(0, 0), { kind: KIND_REMOVE, cell: 0, size: 0, lieParity: 1 }]),
    ).toThrow(/inconsistent with claimed class/);
  });

  test("empty chunk rejected", () => {
    const pair = playersA();
    const { contract, privateState, state } = setup(pair);
    expect(() => settleChunk(contract, state, privateState, pair, 0, [])).toThrow(/empty chunk/);
  });

  test("reserve exhaustion: a 4th small is rejected", () => {
    const pair = playersA();
    const { contract, privateState, state } = setup(pair);
    const moves = [
      P(0, 0), P(4, 0), P(1, 0), P(5, 0), P(8, 0),
      R(8), P(10, 1), P(12, 0), P(3, 1), P(13, 0),
    ];
    expect(() =>
      settleChunk(contract, state, privateState, pair, 0, moves),
    ).toThrow(/no piece of that size left/);
  });

  test("token for the wrong action is rejected", () => {
    const pair = playersA();
    const { contract, privateState, state } = setup(pair);
    const chunk = packChunk(pair, 0, [P(0, 0)]);
    chunk.paths[0] = pair.x.token.pathFor(0, KIND_PLACE, 1, 0);
    chunk.secrets[0] = pair.x.token.secrets[0][1];
    const ctx = newCircuitCtx(state, createTicTacToePrivateState(pair.x.secret), 1000);
    expect(() =>
      contract.impureCircuits.settle(
        ctx, pair.gameId, chunk.nMoves, chunk.parities, chunk.kinds, chunk.cells, chunk.sizes, chunk.secrets, chunk.paths, 5000n,
      ),
    ).toThrow(/invalid one-time token/);
  });
});

// ── Wrong-class (4-bit roll) fraud ──────────────────────────────────────────

describe("proveWrongParity (roll-class lie)", () => {
  function settleWithLie(pair: TestPair) {
    const { contract, privateState, state } = setup(pair);
    // 5 honest placements (X at {2,0,5} — no line), then t5: O claims
    // class 1 (a lie — the real roll is v=0 -> remove class) and places.
    const moves: ScriptMove[] = [
      P(2, 0), P(4, 0), P(0, 0), P(15, 0), P(5, 0),
      { kind: KIND_PLACE, cell: 9, size: 0, lieParity: 1 },
    ];
    const s1 = settleChunk(contract, state, privateState, pair, 0, moves);
    return { contract, privateState, state: s1 };
  }

  test("a class lie costs the lying mover the game", () => {
    const pair = playersA();
    const { contract, privateState, state } = settleWithLie(pair);
    const it = intentFor(pair, 5);
    const rv = revealFor(pair, 5, it.slot);
    const ctx = newCircuitCtx(state, privateState, 1200);
    const res = (contract.impureCircuits as any).proveWrongParity(
      ctx,
      pair.gameId,
      5n,
      BigInt(it.slot),
      BigInt(it.bits[0]), BigInt(it.bits[1]), BigInt(it.bits[2]), BigInt(it.bits[3]),
      it.secret, it.path,
      BigInt(rv.bits[0]), BigInt(rv.bits[1]), BigInt(rv.bits[2]), BigInt(rv.bits[3]),
      rv.random, rv.path,
    );
    const d = dynOf(led(res.context.currentQueryContext.state), pair);
    expect(d.winner).toBe(Winner.x);
    expect(d.status).toBe(Status.settled);
  });

  test("an honest turn cannot be 'proven' wrong", () => {
    const pair = playersA();
    const { contract, privateState, state } = settleWithLie(pair);
    const it = intentFor(pair, 1);
    const rv = revealFor(pair, 1, it.slot);
    const ctx = newCircuitCtx(state, privateState, 1200);
    expect(() =>
      (contract.impureCircuits as any).proveWrongParity(
        ctx, pair.gameId, 1n, BigInt(it.slot),
        BigInt(it.bits[0]), BigInt(it.bits[1]), BigInt(it.bits[2]), BigInt(it.bits[3]),
        it.secret, it.path,
        BigInt(rv.bits[0]), BigInt(rv.bits[1]), BigInt(rv.bits[2]), BigInt(rv.bits[3]),
        rv.random, rv.path,
      ),
    ).toThrow(/claimed class matches/);
  });

  test("uncommitted turns and turn 0 are rejected", () => {
    const pair = playersA();
    const { contract, privateState, state } = settleWithLie(pair);
    const it7 = intentFor(pair, 7);
    const rv7 = revealFor(pair, 7, it7.slot);
    let ctx = newCircuitCtx(state, privateState, 1200);
    expect(() =>
      (contract.impureCircuits as any).proveWrongParity(
        ctx, pair.gameId, 7n, BigInt(it7.slot),
        0n, 0n, 0n, 0n, it7.secret, it7.path,
        0n, 0n, 0n, 0n, rv7.random, rv7.path,
      ),
    ).toThrow(/turn not committed/);
    ctx = newCircuitCtx(state, privateState, 1200);
    expect(() =>
      (contract.impureCircuits as any).proveWrongParity(
        ctx, pair.gameId, 0n, 0n,
        0n, 0n, 0n, 0n, it7.secret, it7.path,
        0n, 0n, 0n, 0n, rv7.random, rv7.path,
      ),
    ).toThrow(/turn 0 has no randomness ceremony/);
  });
});

// ── Equivocation proofs ─────────────────────────────────────────────────────

describe("equivocation fraud proofs", () => {
  test("T-tree: two actions for the same turn -> cheater loses", () => {
    const pair = playersA();
    const { contract, privateState, state } = setup(pair);
    const t = 2;
    const ctx = newCircuitCtx(state, privateState, 1000);
    const res = (contract.impureCircuits as any).proveEquivocationByX(
      ctx,
      pair.gameId,
      BigInt(t),
      1n, 4n, 0n, pair.x.token.secrets[t][4], pair.x.token.pathFor(t, KIND_PLACE, 4, 0),
      1n, 5n, 0n, pair.x.token.secrets[t][5], pair.x.token.pathFor(t, KIND_PLACE, 5, 0),
    );
    const d = dynOf(led(res.context.currentQueryContext.state), pair);
    expect(d.winner).toBe(Winner.o);
    expect(d.status).toBe(Status.settled);
  });

  test("T-tree: identical action pair rejected", () => {
    const pair = playersA();
    const { contract, privateState, state } = setup(pair);
    const path = pair.x.token.pathFor(2, KIND_PLACE, 4, 0);
    const secret = pair.x.token.secrets[2][4];
    const ctx = newCircuitCtx(state, privateState, 1000);
    expect(() =>
      (contract.impureCircuits as any).proveEquivocationByX(
        ctx, pair.gameId, 2n, 1n, 4n, 0n, secret, path, 1n, 4n, 0n, secret, path,
      ),
    ).toThrow(/same action/);
  });

  test("I-tree: forged second leaf rejected; same-leaf pair rejected", () => {
    const pair = playersA();
    const { contract, privateState, state } = setup(pair);
    const t = 3;
    const slot = pair.o.index.slots[t];
    const bits = pair.o.index.bits[t];
    const secret = pair.o.index.secrets[t];
    const path = pair.o.index.pathFor(t);
    const bigBits = bits.map((b) => BigInt(b)) as [bigint, bigint, bigint, bigint];
    let ctx = newCircuitCtx(state, privateState, 1000);
    expect(() =>
      (contract.impureCircuits as any).proveIndexEquivocationByO(
        ctx, pair.gameId, BigInt(t),
        BigInt(slot), ...bigBits, secret, path,
        BigInt((slot + 1) % 16), ...bigBits, secret, path,
      ),
    ).toThrow(/index B is not a valid O index leaf/);
    ctx = newCircuitCtx(state, privateState, 1000);
    expect(() =>
      (contract.impureCircuits as any).proveIndexEquivocationByO(
        ctx, pair.gameId, BigInt(t),
        BigInt(slot), ...bigBits, secret, path,
        BigInt(slot), ...bigBits, secret, path,
      ),
    ).toThrow(/same index leaf/);
  });

  test("R-tree: forged second random rejected; same-leaf pair rejected", () => {
    const pair = playersA();
    const { contract, privateState, state } = setup(pair);
    const t = 2, slot = 5;
    const bits = pair.x.random.bits[t][slot].map((b) => BigInt(b)) as [bigint, bigint, bigint, bigint];
    const random = pair.x.random.randoms[t][slot];
    const path = pair.x.random.pathFor(t, slot);
    const other = new Uint8Array(random);
    other[0] ^= 1;
    let ctx = newCircuitCtx(state, privateState, 1000);
    expect(() =>
      (contract.impureCircuits as any).proveRandomEquivocationByX(
        ctx, pair.gameId, BigInt(t), BigInt(slot),
        ...bits, random, path,
        ...bits, other, path,
      ),
    ).toThrow(/random B is not a valid X random leaf/);
    ctx = newCircuitCtx(state, privateState, 1000);
    expect(() =>
      (contract.impureCircuits as any).proveRandomEquivocationByX(
        ctx, pair.gameId, BigInt(t), BigInt(slot),
        ...bits, random, path,
        ...bits, random, path,
      ),
    ).toThrow(/same random leaf/);
  });
});

// ── Timeout ─────────────────────────────────────────────────────────────────

describe("timeout", () => {
  test("waiting player arms; staller forfeits after the deadline", () => {
    const pair = playersA();
    const { contract, privateState, state } = setup(pair);
    const s1 = settleChunk(contract, state, privateState, pair, 0, [P(0, 0)]);
    expect(Number(dynOf(led(s1), pair).turnMark)).toBe(2);

    let ctx = newCircuitCtx(s1, privateState, 1100);
    const armed = (contract.impureCircuits as any).startTimeout(ctx, pair.gameId, 2000n);
    expect(dynOf(led(armed.context.currentQueryContext.state), pair).hasDeadline).toBe(true);

    ctx = newCircuitCtx(armed.context.currentQueryContext.state, privateState, 1500);
    expect(() => (contract.impureCircuits as any).claimTimeout(ctx, pair.gameId)).toThrow(/deadline has not been reached/);

    ctx = newCircuitCtx(armed.context.currentQueryContext.state, privateState, 2500);
    const claimed = (contract.impureCircuits as any).claimTimeout(ctx, pair.gameId);
    const d = dynOf(led(claimed.context.currentQueryContext.state), pair);
    expect(d.winner).toBe(Winner.x);
    expect(d.status).toBe(Status.settled);
  });

  test("the player to move cannot arm the timeout", () => {
    const pair = playersA();
    const { contract, privateState, state } = setup(pair);
    const s1 = settleChunk(contract, state, privateState, pair, 0, [P(0, 0)]);
    const oPrivate = createTicTacToePrivateState(pair.o.secret);
    const ctx = newCircuitCtx(s1, oPrivate, 1100);
    expect(() => (contract.impureCircuits as any).startTimeout(ctx, pair.gameId, 2000n)).toThrow(/only the waiting player/);
  });
});
