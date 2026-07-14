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
import { createWitnesses, createNixNaxPrivateState } from "../src/contract/witnesses.ts";
import {
  playersA,
  playersB,
  playersC,
  playersD,
  playersE,
  packChunk,
  intentFor,
  revealFor,
  buildMaliciousIndexTree,
  buildMaliciousTokenTree,
  SIXTEEN_C,
  ZERO_PATH_7,
  ZERO_PATH_11,
  ZERO_BYTES32,
  type TestPair,
  type ScriptMove,
} from "./helpers/fixtures.ts";
import { KIND_PLACE, KIND_REMOVE, KIND_PASS } from "../src/sdk/game/rules.ts";

const ZERO_KEY = new Uint8Array(32);
const CONTRACT_ADDR = "0".repeat(64);

// Minimum challenge/timeout/response window the sim deploys with. Kept at the
// production default so the boundary tests exercise the real floor semantics.
const SIM_MIN_WINDOW = 600n;

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
  const privateState = createNixNaxPrivateState(playerSecret ?? pair.x.secret);
  const contract = new Contract(createWitnesses() as any);

  const ctorCtx = createConstructorContext(privateState, ZERO_KEY as any);
  const deployed = contract.initialState(ctorCtx, SIM_MIN_WINDOW);

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

  test("input format: zero identity / zero roots / identity collision rejected", () => {
    const pair = playersA();
    const other = playersB();
    const { contract, privateState, state } = setup(pair);
    const ZERO32 = new Uint8Array(32);
    const freshId = other.gameId; // unused gameId on this contract
    let ctx = newCircuitCtx(state, privateState, 200);
    expect(() =>
      (contract.impureCircuits as any).createGame(
        ctx, freshId, ZERO32, other.x.token.root, other.x.index.root, other.x.random.root,
      ),
    ).toThrow(/identity must not be zero/);
    ctx = newCircuitCtx(state, privateState, 200);
    expect(() =>
      (contract.impureCircuits as any).createGame(
        ctx, freshId, other.x.id, { field: 0n }, other.x.index.root, other.x.random.root,
      ),
    ).toThrow(/token root must not be zero/);
    // Joining with the creator's own identity would break callerMark's X/O
    // resolution — rejected.
    ctx = newCircuitCtx(state, privateState, 200);
    const created = (contract.impureCircuits as any).createGame(
      ctx, freshId, other.x.id, other.x.token.root, other.x.index.root, other.x.random.root,
    );
    ctx = newCircuitCtx(created.context.currentQueryContext.state, privateState, 210);
    expect(() =>
      (contract.impureCircuits as any).joinGame(
        ctx, freshId, other.x.id, other.o.token.root, other.o.index.root, other.o.random.root,
      ),
    ).toThrow(/joiner identity must differ/);
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

  const RECIP = { bytes: new Uint8Array(32).fill(7) }; // dummy ZswapCoinPublicKey

  test("winner finalises + mints a win-token after the window", () => {
    const pair = playersC();
    const { contract, privateState, state } = setup(pair); // private state = X's secret (X wins)
    const s1 = settleChunk(contract, state, privateState, pair, 0, WIN_X, { until: 2000n });
    const ctx = newCircuitCtx(s1, privateState, 2500);
    const fin = (contract.impureCircuits as any).claimResult(ctx, pair.gameId, RECIP);
    const d = dynOf(led(fin.context.currentQueryContext.state), pair);
    expect(d.status).toBe(Status.settled);
    expect(d.winner).toBe(Winner.x);
  });

  test("the loser cannot finalise a decided game", () => {
    const pair = playersC();
    const { contract, privateState, state } = setup(pair, pair.o.secret); // O = loser
    const s1 = settleChunk(contract, state, privateState, pair, 0, WIN_X, { until: 2000n });
    const ctx = newCircuitCtx(s1, privateState, 2500);
    expect(() => (contract.impureCircuits as any).claimResult(ctx, pair.gameId, RECIP))
      .toThrow(/only the winner/);
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

  test("removing your OWN piece is allowed — returns to your reserve", () => {
    const pair = playersA();
    const { contract, privateState, state } = setup(pair);
    // X c2, O c4, X c0, O c15, X c5, then O (turn 5 = remove) takes its OWN c4.
    const l = led(settleChunk(contract, state, privateState, pair, 0,
      [P(2, 0), P(4, 0), P(0, 0), P(15, 0), P(5, 0), R(4)]));
    expect(topAt(l, pair, 4)).toBe(0);          // O's own c4 is gone
    expect(reserveOf(l, pair, 2, 0)).toBe(2);   // returned to O (placed 2 size-0, removed 1)
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
    const ctx = newCircuitCtx(state, createNixNaxPrivateState(pair.x.secret), 1000);
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
    // M1: a proven fraud leaves the game inProgress-but-decided so the winner
    // can still claimResult to mint; it is no longer terminal on its own.
    expect(d.status).toBe(Status.inProgress);
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
    expect(d.status).toBe(Status.inProgress); // M1: decided, pending claimResult
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
    expect(d.status).toBe(Status.inProgress); // M1: decided, pending claimResult
  });

  test("the player to move cannot arm the timeout", () => {
    const pair = playersA();
    const { contract, privateState, state } = setup(pair);
    const s1 = settleChunk(contract, state, privateState, pair, 0, [P(0, 0)]);
    const oPrivate = createNixNaxPrivateState(pair.o.secret);
    const ctx = newCircuitCtx(s1, oPrivate, 1100);
    expect(() => (contract.impureCircuits as any).startTimeout(ctx, pair.gameId, 2000n)).toThrow(/only the waiting player/);
  });
});

// ── Roll-class dispute (M2: challenge / answer / forfeit) ────────────────────
// Closes the data-availability gap: a mover who settles turns unilaterally
// (never running the off-chain ceremony) can be challenged; only a mover who
// actually holds the responder's R-reveal can answer.
describe("roll-class dispute", () => {
  const RECIP = { bytes: new Uint8Array(32).fill(9) };
  const OPENING = [P(2, 0), P(4, 0), P(0, 0), P(15, 0), P(1, 0)]; // turns 0..4, all honest places

  function answerArgs(pair: TestPair, turn: number) {
    const it = intentFor(pair, turn);
    const rv = revealFor(pair, turn, it.slot);
    return [
      BigInt(it.slot),
      BigInt(it.bits[0]), BigInt(it.bits[1]), BigInt(it.bits[2]), BigInt(it.bits[3]),
      it.secret, it.path,
      BigInt(rv.bits[0]), BigInt(rv.bits[1]), BigInt(rv.bits[2]), BigInt(rv.bits[3]),
      rv.random, rv.path,
    ] as const;
  }

  test("challenged honest turn: mover answers, challenge clears, turn is not re-challengeable", () => {
    const pair = playersA();
    const { contract, privateState, state } = setup(pair, pair.o.secret); // O challenges
    const s1 = settleChunk(contract, state, privateState, pair, 0, OPENING);
    // O (responder of even turn 2) demands turn 2's roll evidence.
    let ctx = newCircuitCtx(s1, privateState, 1100);
    const ch = (contract.impureCircuits as any).challengeRoll(ctx, pair.gameId, 2n, 1800n);
    let st = ch.context.currentQueryContext.state;
    expect(dynOf(led(st), pair).hasRollChallenge).toBe(true);
    // The mover answers with both ceremony reveals — challenge clears.
    ctx = newCircuitCtx(st, privateState, 1200);
    const ans = (contract.impureCircuits as any).answerRollChallenge(ctx, pair.gameId, ...answerArgs(pair, 2));
    st = ans.context.currentQueryContext.state;
    expect(dynOf(led(st), pair).hasRollChallenge).toBe(false);
    expect(dynOf(led(st), pair).winner).toBe(Winner.none);
    // The same turn cannot be challenged again (anti-griefing).
    ctx = newCircuitCtx(st, privateState, 1300);
    expect(() => (contract.impureCircuits as any).challengeRoll(ctx, pair.gameId, 2n, 2500n))
      .toThrow(/turn already answered/);
  });

  test("a pending dispute blocks finalising a decided game until answered", () => {
    const pair = playersC();
    const { contract, privateState, state } = setup(pair); // X's secret; X wins
    const s1 = settleChunk(contract, state, privateState, pair, 0, WIN_X, { time: 1000, until: 2000n });
    expect(dynOf(led(s1), pair).winner).toBe(Winner.x);
    // O disputes turn 2 of the winning history.
    const oPrivate = createNixNaxPrivateState(pair.o.secret);
    let ctx = newCircuitCtx(s1, oPrivate, 1100);
    const ch = (contract.impureCircuits as any).challengeRoll(ctx, pair.gameId, 2n, 1800n);
    let st = ch.context.currentQueryContext.state;
    // Even after the challenge window, the winner cannot finalise while pending.
    ctx = newCircuitCtx(st, privateState, 2500);
    expect(() => (contract.impureCircuits as any).claimResult(ctx, pair.gameId, RECIP))
      .toThrow(/roll-class challenge is pending/);
    // X answers; then finalises + mints as usual.
    ctx = newCircuitCtx(st, privateState, 1300);
    const ans = (contract.impureCircuits as any).answerRollChallenge(ctx, pair.gameId, ...answerArgs(pair, 2));
    st = ans.context.currentQueryContext.state;
    ctx = newCircuitCtx(st, privateState, 2500);
    const fin = (contract.impureCircuits as any).claimResult(ctx, pair.gameId, RECIP);
    const d = dynOf(led(fin.context.currentQueryContext.state), pair);
    expect(d.status).toBe(Status.settled);
    expect(d.winner).toBe(Winner.x);
  });

  test("unanswered challenge: mover forfeits after respondBy; winner mints via claimResult", () => {
    const pair = playersA();
    const { contract, privateState, state } = setup(pair, pair.o.secret); // O challenges X's turn
    const s1 = settleChunk(contract, state, privateState, pair, 0, OPENING);
    let ctx = newCircuitCtx(s1, privateState, 1100);
    const ch = (contract.impureCircuits as any).challengeRoll(ctx, pair.gameId, 2n, 1800n);
    let st = ch.context.currentQueryContext.state;
    // Too early to claim the forfeit.
    ctx = newCircuitCtx(st, privateState, 1500);
    expect(() => (contract.impureCircuits as any).claimRollChallenge(ctx, pair.gameId))
      .toThrow(/response window still open/);
    // Past respondBy with no answer: the challenged mover (X) forfeits.
    ctx = newCircuitCtx(st, privateState, 2000);
    const won = (contract.impureCircuits as any).claimRollChallenge(ctx, pair.gameId);
    st = won.context.currentQueryContext.state;
    expect(dynOf(led(st), pair).winner).toBe(Winner.o);
    expect(dynOf(led(st), pair).status).toBe(Status.inProgress); // decided, pending claim
    // O (the winner) finalises + mints.
    ctx = newCircuitCtx(st, privateState, 2100);
    const fin = (contract.impureCircuits as any).claimResult(ctx, pair.gameId, RECIP);
    const d = dynOf(led(fin.context.currentQueryContext.state), pair);
    expect(d.status).toBe(Status.settled);
    expect(d.winner).toBe(Winner.o);
  });

  test("a lied class cannot be answered: the true reveals contradict it", () => {
    const pair = playersA();
    // O lies at t5 (claims place; the real roll is remove class).
    const { contract, privateState, state } = setup(pair); // X's secret; X challenges O's t5
    const moves: ScriptMove[] = [
      ...OPENING.slice(0, 5),
      { kind: KIND_PLACE, cell: 9, size: 0, lieParity: 1 },
    ];
    const s1 = settleChunk(contract, state, privateState, pair, 0, moves);
    let ctx = newCircuitCtx(s1, privateState, 1100);
    const ch = (contract.impureCircuits as any).challengeRoll(ctx, pair.gameId, 5n, 1800n);
    const st = ch.context.currentQueryContext.state;
    // Even with the genuine ceremony reveals, the answer cannot satisfy the
    // class check — the liar's only options are forfeit or self-slash.
    ctx = newCircuitCtx(st, privateState, 1200);
    expect(() => (contract.impureCircuits as any).answerRollChallenge(ctx, pair.gameId, ...answerArgs(pair, 5)))
      .toThrow(/reveals contradict the claimed class/);
  });

  test("guards: mover cannot challenge own turn; response window has a floor; turn must be committed", () => {
    const pair = playersA();
    const { contract, privateState, state } = setup(pair); // X's secret
    const s1 = settleChunk(contract, state, privateState, pair, 0, OPENING);
    // X is the mover of even turn 2 — cannot demand evidence for its own turn.
    let ctx = newCircuitCtx(s1, privateState, 1100);
    expect(() => (contract.impureCircuits as any).challengeRoll(ctx, pair.gameId, 2n, 1800n))
      .toThrow(/only the responder/);
    // X may challenge O's odd turn 3, but not with a near-instant respondBy.
    ctx = newCircuitCtx(s1, privateState, 1100);
    expect(() => (contract.impureCircuits as any).challengeRoll(ctx, pair.gameId, 3n, 1300n))
      .toThrow(/response window too short/);
    // Uncommitted turn / turn 0 rejected.
    ctx = newCircuitCtx(s1, privateState, 1100);
    expect(() => (contract.impureCircuits as any).challengeRoll(ctx, pair.gameId, 9n, 1800n))
      .toThrow(/turn not committed/);
    ctx = newCircuitCtx(s1, privateState, 1100);
    expect(() => (contract.impureCircuits as any).challengeRoll(ctx, pair.gameId, 0n, 1800n))
      .toThrow(/turn 0 has no randomness ceremony/);
  });
});

// ── Security regressions (audit findings C1 / H1 / H2 / M1) ──────────────────
// Each of these FAILS against the pre-fix contract and passes once the fix is in.
describe("security regressions", () => {
  const RECIP = { bytes: new Uint8Array(32).fill(9) }; // dummy ZswapCoinPublicKey

  // C1: challengeUntil was caller-controlled with no floor, so a settler could
  // pass a past/zero window and claimResult before any fraud proof could land.
  test("C1: settle rejects a challenge window below the minimum", () => {
    const pair = playersC();
    const { contract, privateState, state } = setup(pair);
    // window = until(1300) - time(1000) = 300 < MIN_CHALLENGE_SECS (600).
    expect(() =>
      settleChunk(contract, state, privateState, pair, 0, WIN_X, { time: 1000, until: 1300n }),
    ).toThrow(/challenge window too short/);
  });

  // H1: startTimeout only required "in the future", so a waiter could arm a
  // near-instant deadline and forfeit-win before the mover could respond.
  test("H1: startTimeout rejects a deadline below the minimum grace", () => {
    const pair = playersA();
    const { contract, privateState, state } = setup(pair); // X's secret
    const s1 = settleChunk(contract, state, privateState, pair, 0, [P(0, 0)]); // O to move
    const ctx = newCircuitCtx(s1, privateState, 1100); // X (waiter) arms
    // deadline 1300 → window 200 < MIN_TIMEOUT_SECS (600).
    expect(() => (contract.impureCircuits as any).startTimeout(ctx, pair.gameId, 1300n))
      .toThrow(/timeout too short/);
  });

  // H2: after a legitimate deciding settle, the loser could arm+claim a timeout
  // to overwrite the winner. startTimeout must refuse a decided game.
  test("H2: the loser cannot hijack a decided game via the timeout path", () => {
    const pair = playersC();
    const { contract, privateState, state } = setup(pair); // X's secret; X wins
    const s1 = settleChunk(contract, state, privateState, pair, 0, WIN_X, { time: 1000, until: 3000n });
    expect(dynOf(led(s1), pair).winner).toBe(Winner.x);
    const oPrivate = createNixNaxPrivateState(pair.o.secret);
    const ctx = newCircuitCtx(s1, oPrivate, 1100);
    expect(() => (contract.impureCircuits as any).startTimeout(ctx, pair.gameId, 3000n))
      .toThrow(/game already decided/);
  });

  // M1: a win proven by fraud proof left the game settled with no mint path, so
  // the honest winner could never claim the reward token. Now they can.
  test("M1: a fraud-proof winner can finalise and mint the reward", () => {
    const pair = playersA();
    const { contract, privateState, state } = setup(pair); // X's secret
    // O lies about the class at t5 (real roll = remove); X proves it → X wins.
    const moves: ScriptMove[] = [
      P(2, 0), P(4, 0), P(0, 0), P(15, 0), P(5, 0),
      { kind: KIND_PLACE, cell: 9, size: 0, lieParity: 1 },
    ];
    const s1 = settleChunk(contract, state, privateState, pair, 0, moves);
    const it = intentFor(pair, 5);
    const rv = revealFor(pair, 5, it.slot);
    let ctx = newCircuitCtx(s1, privateState, 1200);
    const proven = (contract.impureCircuits as any).proveWrongParity(
      ctx, pair.gameId, 5n, BigInt(it.slot),
      BigInt(it.bits[0]), BigInt(it.bits[1]), BigInt(it.bits[2]), BigInt(it.bits[3]), it.secret, it.path,
      BigInt(rv.bits[0]), BigInt(rv.bits[1]), BigInt(rv.bits[2]), BigInt(rv.bits[3]), rv.random, rv.path,
    );
    const st = proven.context.currentQueryContext.state;
    expect(dynOf(led(st), pair).winner).toBe(Winner.x);
    expect(dynOf(led(st), pair).status).toBe(Status.inProgress);
    // No challenge window applies to a proven result — winner finalises now.
    ctx = newCircuitCtx(st, privateState, 1300);
    const fin = (contract.impureCircuits as any).claimResult(ctx, pair.gameId, RECIP);
    const d = dynOf(led(fin.context.currentQueryContext.state), pair);
    expect(d.status).toBe(Status.settled);
    expect(d.winner).toBe(Winner.x);
  });

  // M1: same for a timeout win — the forfeit winner must be able to mint too.
  test("M1: a timeout winner can finalise and mint the reward", () => {
    const pair = playersA();
    const { contract, privateState, state } = setup(pair); // X's secret
    const s1 = settleChunk(contract, state, privateState, pair, 0, [P(0, 0)]); // O to move
    let ctx = newCircuitCtx(s1, privateState, 1100);
    const armed = (contract.impureCircuits as any).startTimeout(ctx, pair.gameId, 2000n); // window 900 > 600
    ctx = newCircuitCtx(armed.context.currentQueryContext.state, privateState, 2500);
    const claimed = (contract.impureCircuits as any).claimTimeout(ctx, pair.gameId);
    const st = claimed.context.currentQueryContext.state;
    expect(dynOf(led(st), pair).winner).toBe(Winner.x);
    expect(dynOf(led(st), pair).status).toBe(Status.inProgress);
    ctx = newCircuitCtx(st, privateState, 2600);
    const fin = (contract.impureCircuits as any).claimResult(ctx, pair.gameId, RECIP);
    const d = dynOf(led(fin.context.currentQueryContext.state), pair);
    expect(d.status).toBe(Status.settled);
    expect(d.winner).toBe(Winner.x);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// ADVERSARIAL SUITE — every way a player might try to cheat, and the proof the
// contract stops it. Grouped by attack class.
// ═════════════════════════════════════════════════════════════════════════════

const RECIP = { bytes: new Uint8Array(32).fill(7) };
const secretPS = (pair: TestPair, who: "x" | "o") => createNixNaxPrivateState(pair[who].secret);

// ── 1.1 Token replay / forgery ──────────────────────────────────────────────
describe("cheat: token replay & forgery", () => {
  test("a turn-t token cannot be replayed at a different turn", () => {
    const pair = playersC();
    const { contract, privateState, state } = setup(pair);
    // Build a legit 2-move chunk, then swap move 1's PATH for turn 0's token —
    // the recomputed leaf (turn 1) can't match a turn-0 leaf.
    const c = packChunk(pair, 0, [P(0, 0), P(4, 0)]);
    c.paths[1] = pair.x.token.pathFor(0, KIND_PLACE, 0, 0);
    const ctx = newCircuitCtx(state, privateState, 5000);
    expect(() =>
      contract.impureCircuits.settle(
        ctx, pair.gameId, c.nMoves, c.parities, c.kinds, c.cells, c.sizes, c.secrets, c.paths, 6000n,
      ),
    ).toThrow(/invalid one-time token/);
  });

  test("X's turn cannot be settled with O's token (root is chosen by parity)", () => {
    const pair = playersC();
    const { contract, privateState, state } = setup(pair);
    // Turn 0 is X's; feed O's token for the same action → verified against rootX → fails.
    const c = packChunk(pair, 0, [P(0, 0)]);
    c.paths[0] = pair.o.token.pathFor(0, KIND_PLACE, 0, 0);
    const ctx = newCircuitCtx(state, privateState, 5000);
    expect(() =>
      contract.impureCircuits.settle(
        ctx, pair.gameId, c.nMoves, c.parities, c.kinds, c.cells, c.sizes, c.secrets, c.paths, 6000n,
      ),
    ).toThrow(/invalid one-time token/);
  });

  test("cross-game replay fails: a token valid in game 1 is rejected in game 2", () => {
    const g1 = playersC();
    const g2Id = playersA().gameId; // a distinct gameId
    // Open a SECOND game that (maliciously) registers game 1's exact roots + ids.
    const hybrid: TestPair = { ...g1, gameId: g2Id };
    const { contract, privateState, state } = setup(hybrid);
    // Try to play a move using g1's token — its leaf preimage embeds g1.gameId,
    // but settle recomputes the leaf with g2Id, so it can't be under the root.
    expect(() =>
      settleChunk(contract, state, privateState, hybrid, 0, [P(0, 0)]),
    ).toThrow(/invalid one-time token/);
  });

  test("an already-committed chunk cannot be re-settled (double-spend)", () => {
    const pair = playersC();
    const { contract, privateState, state } = setup(pair);
    const s1 = settleChunk(contract, state, privateState, pair, 0, WIN_X.slice(0, 3));
    // Re-submit the same 3 moves from base 0 — committedTurns is already 3, so
    // these turns collide with the parity/root the contract now expects at 3,4,5.
    expect(() =>
      settleChunk(contract, s1, privateState, pair, 0, WIN_X.slice(0, 3), { time: 1100 }),
    ).toThrow(/invalid one-time token/);
  });
});

// ── 1.2 Winner-flip triangle (settle ↔ fraud ↔ dispute) ─────────────────────
describe("cheat: winner-flip during the challenge window", () => {
  test("slash-the-winner: an equivocation proof flips a settled win to the honest player", () => {
    const pair = playersC();
    const { contract, privateState, state } = setup(pair); // X's secret
    // X 'wins' via settle (winner=x, challenge window open).
    const s1 = settleChunk(contract, state, privateState, pair, 0, WIN_X, { time: 1000, until: 3000n });
    expect(dynOf(led(s1), pair).winner).toBe(Winner.x);
    // O proves X equivocated on turn 2 (two distinct valid X tokens) DURING the window.
    const ctx = newCircuitCtx(s1, secretPS(pair, "o"), 1500);
    const res = (contract.impureCircuits as any).proveEquivocationByX(
      ctx, pair.gameId, 2n,
      1n, 4n, 0n, pair.x.token.secrets[2][4], pair.x.token.pathFor(2, KIND_PLACE, 4, 0),
      1n, 5n, 0n, pair.x.token.secrets[2][5], pair.x.token.pathFor(2, KIND_PLACE, 5, 0),
    );
    const st = res.context.currentQueryContext.state;
    expect(dynOf(led(st), pair).winner).toBe(Winner.o); // flipped to the honest player
    // …and O (now the winner) finalises + mints.
    const ctx2 = newCircuitCtx(st, secretPS(pair, "o"), 1600);
    const fin = (contract.impureCircuits as any).claimResult(ctx2, pair.gameId, RECIP);
    expect(dynOf(led(fin.context.currentQueryContext.state), pair).winner).toBe(Winner.o);
    expect(dynOf(led(fin.context.currentQueryContext.state), pair).status).toBe(Status.settled);
  });

  test("a fraud proof cannot re-flip an already fraud-decided game", () => {
    const pair = playersA();
    const { contract, privateState, state } = setup(pair);
    // First proof (no prior settle → winner none): O slashes X → decided, hasChallenge=false.
    let ctx = newCircuitCtx(state, privateState, 1000);
    const r1 = (contract.impureCircuits as any).proveEquivocationByX(
      ctx, pair.gameId, 2n,
      1n, 4n, 0n, pair.x.token.secrets[2][4], pair.x.token.pathFor(2, KIND_PLACE, 4, 0),
      1n, 5n, 0n, pair.x.token.secrets[2][5], pair.x.token.pathFor(2, KIND_PLACE, 5, 0),
    );
    const st = r1.context.currentQueryContext.state;
    expect(dynOf(led(st), pair).winner).toBe(Winner.o);
    // Second proof (X tries to slash O back) → blocked by the contestable guard.
    ctx = newCircuitCtx(st, privateState, 1100);
    expect(() =>
      (contract.impureCircuits as any).proveEquivocationByO(
        ctx, pair.gameId, 3n,
        1n, 4n, 0n, pair.o.token.secrets[3][4], pair.o.token.pathFor(3, KIND_PLACE, 4, 0),
        1n, 5n, 0n, pair.o.token.secrets[3][5], pair.o.token.pathFor(3, KIND_PLACE, 5, 0),
      ),
    ).toThrow(/outcome no longer contestable/);
  });

  test("settle disarms a pending timeout (making a move cancels the forfeit clock)", () => {
    const pair = playersC();
    const { contract, privateState, state } = setup(pair);
    const s1 = settleChunk(contract, state, privateState, pair, 0, [P(0, 0)]); // O to move
    // X (waiter) arms a timeout on O.
    let ctx = newCircuitCtx(s1, secretPS(pair, "x"), 1100);
    const armed = (contract.impureCircuits as any).startTimeout(ctx, pair.gameId, 2000n);
    let st = armed.context.currentQueryContext.state;
    expect(dynOf(led(st), pair).hasDeadline).toBe(true);
    // O responds by settling its move → hasDeadline cleared.
    st = settleChunk(contract, st, secretPS(pair, "o"), pair, 1, [P(4, 0)], { time: 1200, until: 3000n });
    expect(dynOf(led(st), pair).hasDeadline).toBe(false);
    // The stale timeout can no longer be claimed.
    ctx = newCircuitCtx(st, secretPS(pair, "x"), 2500);
    expect(() => (contract.impureCircuits as any).claimTimeout(ctx, pair.gameId))
      .toThrow(/no timeout has been armed/);
  });

  test("claimTimeout while a roll challenge is pending decides cleanly and clears it", () => {
    const pair = playersA();
    const { contract, privateState, state } = setup(pair);
    const s1 = settleChunk(contract, state, privateState, pair, 0, [P(0, 0), P(4, 0), P(1, 0)]); // 3 moves; X to move next (turn 3? committed=3 → turnMark for turn3 = O)
    // O (waiter relative to turnMark) arms a timeout; also file a roll challenge on turn 1.
    const waiter = dynOf(led(s1), pair).turnMark === 1 ? "o" : "x";
    let ctx = newCircuitCtx(s1, secretPS(pair, waiter), 1100);
    const armed = (contract.impureCircuits as any).startTimeout(ctx, pair.gameId, 2000n);
    let st = armed.context.currentQueryContext.state;
    // Responder of turn 1 (turn 1 mover is O, so responder is X) challenges the roll.
    ctx = newCircuitCtx(st, secretPS(pair, "x"), 1150);
    const ch = (contract.impureCircuits as any).challengeRoll(ctx, pair.gameId, 1n, 2000n);
    st = ch.context.currentQueryContext.state;
    expect(dynOf(led(st), pair).hasRollChallenge).toBe(true);
    // Timeout fires: the game decides and the pending roll challenge is wiped.
    ctx = newCircuitCtx(st, secretPS(pair, waiter), 2500);
    const done = (contract.impureCircuits as any).claimTimeout(ctx, pair.gameId);
    const d = dynOf(led(done.context.currentQueryContext.state), pair);
    expect(d.winner).not.toBe(Winner.none);
    expect(d.hasRollChallenge).toBe(false);
  });
});

// ── 1.3 Opponent wins by the mover's own move (oppWins branch) ───────────────
describe("cheat: forced move hands the opponent the win", () => {
  test("removing your own cover reveals the OPPONENT's line → opponent wins", () => {
    const pair = playersD(); // remove window at t8 (X's turn)
    const { contract, privateState, state } = setup(pair);
    // O builds tops at 4,5,6 and hides a 4th under X's cover at c7; X's forced
    // remove at t8 takes its own cover, revealing O's 4-in-a-row.
    const moves: ScriptMove[] = [
      P(0, 0), P(7, 0), P(7, 1), P(4, 0), P(1, 0), P(5, 0), P(2, 0), P(6, 1), R(7),
    ];
    const s1 = settleChunk(contract, state, privateState, pair, 0, moves);
    const l = led(s1);
    expect(dynOf(l, pair).winner).toBe(Winner.o); // opponent won on X's move
    expect(topAt(l, pair, 7)).toBe(2);            // O revealed beneath
  });
});

// ── 1.4 claimResult abuse ───────────────────────────────────────────────────
describe("cheat: claimResult abuse", () => {
  test("cannot finalise while the challenge window is still open", () => {
    const pair = playersC();
    const { contract, privateState, state } = setup(pair);
    const s1 = settleChunk(contract, state, privateState, pair, 0, WIN_X, { time: 1000, until: 3000n });
    const ctx = newCircuitCtx(s1, privateState, 1500); // before challengeUntil (3000)
    expect(() => (contract.impureCircuits as any).claimResult(ctx, pair.gameId, RECIP))
      .toThrow(/challenge window still open/);
  });

  test("cannot finalise twice (no double mint)", () => {
    const pair = playersC();
    const { contract, privateState, state } = setup(pair);
    const s1 = settleChunk(contract, state, privateState, pair, 0, WIN_X, { time: 1000, until: 2000n });
    let ctx = newCircuitCtx(s1, privateState, 2500);
    const fin = (contract.impureCircuits as any).claimResult(ctx, pair.gameId, RECIP);
    const st = fin.context.currentQueryContext.state;
    ctx = newCircuitCtx(st, privateState, 2600);
    expect(() => (contract.impureCircuits as any).claimResult(ctx, pair.gameId, RECIP))
      .toThrow(/already finalised/);
  });

  test("a non-player cannot finalise a decided game", () => {
    const pair = playersC();
    const { contract, privateState, state } = setup(pair);
    const s1 = settleChunk(contract, state, privateState, pair, 0, WIN_X, { time: 1000, until: 2000n });
    const stranger = createNixNaxPrivateState(new Uint8Array(32).fill(123));
    const ctx = newCircuitCtx(s1, stranger, 2500);
    expect(() => (contract.impureCircuits as any).claimResult(ctx, pair.gameId, RECIP))
      .toThrow(/prove knowledge of a registered player secret/);
  });

  test("cannot finalise an undecided game even after its window expires", () => {
    const pair = playersA();
    const { contract, privateState, state } = setup(pair);
    // Settle a non-winning chunk (no winner), let the window pass, try to finalise.
    const s1 = settleChunk(contract, state, privateState, pair, 0, [P(0, 0), P(4, 0)], { time: 1000, until: 2000n });
    expect(dynOf(led(s1), pair).winner).toBe(Winner.none);
    const ctx = newCircuitCtx(s1, privateState, 2500);
    expect(() => (contract.impureCircuits as any).claimResult(ctx, pair.gameId, RECIP))
      .toThrow(/no decided outcome/);
  });

  test("recipient must not be the zero key (no accidental burn)", () => {
    const pair = playersC();
    const { contract, privateState, state } = setup(pair);
    const s1 = settleChunk(contract, state, privateState, pair, 0, WIN_X, { time: 1000, until: 2000n });
    const ctx = newCircuitCtx(s1, privateState, 2500);
    expect(() => (contract.impureCircuits as any).claimResult(ctx, pair.gameId, { bytes: new Uint8Array(32) }))
      .toThrow(/recipient must not be the zero key/);
  });
});

// ── 1.5 Dispute-edge abuse ──────────────────────────────────────────────────
describe("cheat: roll-dispute edge abuse", () => {
  const OPENING = [P(2, 0), P(4, 0), P(0, 0), P(15, 0), P(1, 0)];

  test("a non-player cannot file a roll challenge", () => {
    const pair = playersA();
    const { contract, privateState, state } = setup(pair);
    const s1 = settleChunk(contract, state, privateState, pair, 0, OPENING);
    const stranger = createNixNaxPrivateState(new Uint8Array(32).fill(200));
    const ctx = newCircuitCtx(s1, stranger, 1100);
    expect(() => (contract.impureCircuits as any).challengeRoll(ctx, pair.gameId, 2n, 1800n))
      .toThrow(/prove knowledge of a registered player secret/);
  });

  test("answering with the wrong slot's reveals is rejected", () => {
    const pair = playersA();
    const { contract, privateState, state } = setup(pair, pair.o.secret); // O challenges X's turn 2
    const s1 = settleChunk(contract, state, privateState, pair, 0, OPENING);
    let ctx = newCircuitCtx(s1, privateState, 1100);
    const ch = (contract.impureCircuits as any).challengeRoll(ctx, pair.gameId, 2n, 1800n);
    const st = ch.context.currentQueryContext.state;
    // Real index reveal for turn 2, but a random reveal from the WRONG slot.
    const it = intentFor(pair, 2);
    const wrongSlot = (it.slot + 1) % 16;
    const rv = revealFor(pair, 2, wrongSlot);
    ctx = newCircuitCtx(st, privateState, 1200);
    expect(() =>
      (contract.impureCircuits as any).answerRollChallenge(
        ctx, pair.gameId, BigInt(it.slot),
        BigInt(it.bits[0]), BigInt(it.bits[1]), BigInt(it.bits[2]), BigInt(it.bits[3]), it.secret, it.path,
        BigInt(rv.bits[0]), BigInt(rv.bits[1]), BigInt(rv.bits[2]), BigInt(rv.bits[3]), rv.random, rv.path,
      ),
    ).toThrow(/random reveal is not under/);
  });

  test("answer / claim with nothing pending is rejected", () => {
    const pair = playersA();
    const { contract, privateState, state } = setup(pair);
    const s1 = settleChunk(contract, state, privateState, pair, 0, OPENING);
    const it = intentFor(pair, 2);
    const rv = revealFor(pair, 2, it.slot);
    let ctx = newCircuitCtx(s1, privateState, 1100);
    expect(() =>
      (contract.impureCircuits as any).answerRollChallenge(
        ctx, pair.gameId, BigInt(it.slot),
        BigInt(it.bits[0]), BigInt(it.bits[1]), BigInt(it.bits[2]), BigInt(it.bits[3]), it.secret, it.path,
        BigInt(rv.bits[0]), BigInt(rv.bits[1]), BigInt(rv.bits[2]), BigInt(rv.bits[3]), rv.random, rv.path,
      ),
    ).toThrow(/no roll challenge is pending/);
    ctx = newCircuitCtx(s1, privateState, 1100);
    expect(() => (contract.impureCircuits as any).claimRollChallenge(ctx, pair.gameId))
      .toThrow(/no roll challenge is pending/);
  });

  test("sequential challenges on different turns are allowed after each answer", () => {
    const pair = playersA();
    const { contract, privateState, state } = setup(pair, pair.o.secret); // O challenges X's even turns
    let st = settleChunk(contract, state, privateState, pair, 0, OPENING);
    for (const t of [2, 4]) {
      let ctx = newCircuitCtx(st, privateState, 1100 + t);
      const ch = (contract.impureCircuits as any).challengeRoll(ctx, pair.gameId, BigInt(t), 1800n);
      st = ch.context.currentQueryContext.state;
      const it = intentFor(pair, t);
      const rv = revealFor(pair, t, it.slot);
      ctx = newCircuitCtx(st, privateState, 1200 + t);
      const ans = (contract.impureCircuits as any).answerRollChallenge(
        ctx, pair.gameId, BigInt(it.slot),
        BigInt(it.bits[0]), BigInt(it.bits[1]), BigInt(it.bits[2]), BigInt(it.bits[3]), it.secret, it.path,
        BigInt(rv.bits[0]), BigInt(rv.bits[1]), BigInt(rv.bits[2]), BigInt(rv.bits[3]), rv.random, rv.path,
      );
      st = ans.context.currentQueryContext.state;
      expect(dynOf(led(st), pair).hasRollChallenge).toBe(false);
    }
  });

  test("a second challenge while one is pending is rejected", () => {
    const pair = playersA();
    const { contract, privateState, state } = setup(pair, pair.o.secret);
    const s1 = settleChunk(contract, state, privateState, pair, 0, OPENING);
    let ctx = newCircuitCtx(s1, privateState, 1100);
    const ch = (contract.impureCircuits as any).challengeRoll(ctx, pair.gameId, 2n, 1800n);
    const st = ch.context.currentQueryContext.state;
    ctx = newCircuitCtx(st, privateState, 1150);
    expect(() => (contract.impureCircuits as any).challengeRoll(ctx, pair.gameId, 4n, 1800n))
      .toThrow(/already pending/);
  });
});

// ── 2. Adversarial constructions ────────────────────────────────────────────
describe("cheat: adversarial constructions", () => {
  test("answering with a stashed alternate leaf is self-defeating (equivocation composition)", () => {
    // O commits a MALICIOUS index tree: a second valid leaf for turn 3 stashed
    // at position 5. If O ever answers a turn-3 challenge with the alternate
    // bits, X now holds two valid I-leaves for turn 3 → proveIndexEquivocation.
    const base = playersA();
    const evilTurn = 3, stashAt = 5, altSlot = 7, altBits = [0, 0, 0, 0];
    const mal = buildMaliciousIndexTree(
      base.gameId, evilTurn, stashAt, base.o.index.slots, base.o.index.bits, altSlot, altBits,
    );
    const pair: TestPair = { ...base, o: { ...base.o, index: { ...base.o.index, root: mal.root } } };
    const { contract, privateState, state } = setup(pair);
    const h = mal.honest(evilTurn); // ceremony leaf for turn 3 (pos 3)
    const a = mal.alt;              // alternate leaf, also valid for turn 3 (pos 5)
    const ctx = newCircuitCtx(state, privateState, 1000);
    const res = (contract.impureCircuits as any).proveIndexEquivocationByO(
      ctx, pair.gameId, BigInt(evilTurn),
      BigInt(h.slot), BigInt(h.bits[0]), BigInt(h.bits[1]), BigInt(h.bits[2]), BigInt(h.bits[3]), h.secret, h.path,
      BigInt(a.slot), BigInt(a.bits[0]), BigInt(a.bits[1]), BigInt(a.bits[2]), BigInt(a.bits[3]), a.secret, a.path,
    );
    expect(dynOf(led(res.context.currentQueryContext.state), pair).winner).toBe(Winner.x);
  });

  test("a lying division witness only fails the cheater's own settle", () => {
    // A client with a corrupted wit_divMod2 (flips the low bit) can't settle:
    // isEvenTurn's 2*half + bit == value check rejects it. Opponent unaffected.
    const pair = playersC();
    const badWitnesses = {
      ...createWitnesses(),
      wit_divMod2: (ctx: any, value: bigint): [any, [bigint, bigint]] =>
        [ctx.privateState, [value / 2n, value % 2n === 0n ? 1n : 0n]],
    };
    const privateState = createNixNaxPrivateState(pair.x.secret);
    const contract = new Contract(badWitnesses as any);
    const ctorCtx = createConstructorContext(privateState, ZERO_KEY as any);
    let state = contract.initialState(ctorCtx, SIM_MIN_WINDOW).currentContractState;
    state = openGame(contract, state, privateState, pair); // create/join don't call isEvenTurn
    expect(() =>
      settleChunk(contract, state, privateState, pair, 0, [P(0, 0)]),
    ).toThrow(/parity witness/);
  });
});

// ── The 128-turn draw ───────────────────────────────────────────────────────
describe("full-length game: 128-turn draw", () => {
  test("a game that reaches the turn cap ends in a draw; either player finalises; no mint; turn 129 impossible", () => {
    const pair = playersE();
    const { contract, privateState, state } = setup(pair);
    // X places at cell 0 on evens; O removes it on odds — board never lines up.
    const moves: ScriptMove[] = Array.from({ length: 128 }, (_, t) => (t % 2 === 0 ? P(0, 0) : R(0)));
    const s1 = settleChunk(contract, state, privateState, pair, 0, moves, { time: 1000, until: 5000n });
    const d = dynOf(led(s1), pair);
    expect(Number(d.committedTurns)).toBe(128);
    expect(d.winner).toBe(Winner.draw);
    // Turn 129 is impossible — a decided (drawn) game refuses any further
    // settle. The winner!=none guard fires before move data is read, so a real
    // turn-128 token isn't needed to demonstrate it.
    const dummy = packChunk(pair, 0, [P(1, 0)]);
    const ctx0 = newCircuitCtx(s1, privateState, 5100);
    expect(() =>
      contract.impureCircuits.settle(
        ctx0, pair.gameId, dummy.nMoves, dummy.parities, dummy.kinds, dummy.cells, dummy.sizes, dummy.secrets, dummy.paths, 6000n,
      ),
    ).toThrow(/game already decided/);
    // Either player may finalise a draw; it mints nothing (decided=false).
    const ctx = newCircuitCtx(s1, secretPS(pair, "o"), 6000);
    const fin = (contract.impureCircuits as any).claimResult(ctx, pair.gameId, RECIP);
    const dd = dynOf(led(fin.context.currentQueryContext.state), pair);
    expect(dd.status).toBe(Status.settled);
    expect(dd.winner).toBe(Winner.draw);
  });
});

// ── 3. Boundary values ──────────────────────────────────────────────────────
describe("boundaries: windows, chunk size, ranges", () => {
  // settle's challenge floor is strict: untilTime must be > now + MIN (600).
  test("settle challenge window: exactly-min rejected, min+1 accepted", () => {
    const pair = playersC();
    // now=1000: until=1600 → window 600 (== MIN) rejected; 1601 accepted.
    {
      const { contract, privateState, state } = setup(pair);
      expect(() =>
        settleChunk(contract, state, privateState, pair, 0, [P(0, 0)], { time: 1000, until: 1600n }),
      ).toThrow(/challenge window too short/);
    }
    {
      const p2 = playersD();
      const { contract, privateState, state } = setup(p2);
      const s = settleChunk(contract, state, privateState, p2, 0, [P(0, 0)], { time: 1000, until: 1601n });
      expect(Number(dynOf(led(s), p2).committedTurns)).toBe(1);
    }
  });

  test("claimResult succeeds at exactly challengeUntil (blockTimeGte boundary)", () => {
    const pair = playersC();
    const { contract, privateState, state } = setup(pair);
    const s1 = settleChunk(contract, state, privateState, pair, 0, WIN_X, { time: 1000, until: 2000n });
    // blockTimeGte(challengeUntil) is inclusive: time == 2000 finalises.
    const ctx = newCircuitCtx(s1, privateState, 2000);
    const fin = (contract.impureCircuits as any).claimResult(ctx, pair.gameId, RECIP);
    expect(dynOf(led(fin.context.currentQueryContext.state), pair).status).toBe(Status.settled);
  });

  test("startTimeout deadline floor: exactly-min rejected, min+1 accepted", () => {
    const pair = playersC();
    const { contract, privateState, state } = setup(pair);
    const s1 = settleChunk(contract, state, privateState, pair, 0, [P(0, 0)]);
    // waiter = X (turnMark is O after 1 move)
    let ctx = newCircuitCtx(s1, secretPS(pair, "x"), 1000);
    expect(() => (contract.impureCircuits as any).startTimeout(ctx, pair.gameId, 1600n))
      .toThrow(/timeout too short/);
    ctx = newCircuitCtx(s1, secretPS(pair, "x"), 1000);
    const armed = (contract.impureCircuits as any).startTimeout(ctx, pair.gameId, 1601n);
    expect(dynOf(led(armed.context.currentQueryContext.state), pair).hasDeadline).toBe(true);
  });

  test("nMoves out of range: 0 (empty) and 9 (too large) both rejected", () => {
    const pair = playersC();
    const { contract, privateState, state } = setup(pair);
    // Empty:
    const empty = packChunk(pair, 0, []);
    let ctx = newCircuitCtx(state, privateState, 1000);
    expect(() =>
      contract.impureCircuits.settle(ctx, pair.gameId, empty.nMoves, empty.parities, empty.kinds, empty.cells, empty.sizes, empty.secrets, empty.paths, 5000n),
    ).toThrow(/empty chunk/);
    // n=9 with the packed 8-vectors: force nMoves=9 (chunk capacity is 8).
    const full = packChunk(pair, 0, [P(0,0),P(4,0),P(1,0),P(5,0),P(2,0),P(6,0),P(3,1),P(7,0)]);
    ctx = newCircuitCtx(state, privateState, 1000);
    expect(() =>
      contract.impureCircuits.settle(ctx, pair.gameId, 9n, full.parities, full.kinds, full.cells, full.sizes, full.secrets, full.paths, 5000n),
    ).toThrow(/chunk too large/);
  });

  test("out-of-range move fields are rejected before the token check", () => {
    const pair = playersC();
    // Build a VALID turn-0 chunk, then corrupt one field out of range. The
    // range asserts fire before tokenIsUnder, so the mismatched path is never
    // reached. (packChunk can't build these directly — the token tree has no
    // leaf for an illegal action — hence the post-hoc mutation.)
    const cases: Array<["kinds" | "cells" | "sizes", bigint, RegExp]> = [
      ["kinds", 0n, /unknown action kind/],
      ["kinds", 4n, /unknown action kind/],
      ["cells", 16n, /cell out of range/],
      ["sizes", 4n, /size out of range/],
    ];
    for (const [field, val, rx] of cases) {
      const { contract, privateState, state } = setup(pair);
      const c = packChunk(pair, 0, [P(0, 0)]);
      c[field][0] = val;
      const ctx = newCircuitCtx(state, privateState, 1000);
      expect(() =>
        contract.impureCircuits.settle(ctx, pair.gameId, c.nMoves, c.parities, c.kinds, c.cells, c.sizes, c.secrets, c.paths, 5000n),
      ).toThrow(rx);
    }
  });

  test("claimTimeout with nothing armed is rejected", () => {
    const pair = playersC();
    const { contract, privateState, state } = setup(pair);
    const s1 = settleChunk(contract, state, privateState, pair, 0, [P(0, 0)]);
    const ctx = newCircuitCtx(s1, privateState, 2000);
    expect(() => (contract.impureCircuits as any).claimTimeout(ctx, pair.gameId))
      .toThrow(/no timeout has been armed/);
  });

  test("startTimeout on a half-open (not-yet-joined) game is rejected", () => {
    const pair = playersC();
    const privateState = createNixNaxPrivateState(pair.x.secret);
    const contract = new Contract(createWitnesses() as any);
    let state = contract.initialState(createConstructorContext(privateState, ZERO_KEY as any), SIM_MIN_WINDOW).currentContractState;
    // Only createGame — no joinGame, so status is halfOpen.
    let ctx = newCircuitCtx(state, privateState, 100);
    state = (contract.impureCircuits as any).createGame(
      ctx, pair.gameId, pair.x.id, pair.x.token.root, pair.x.index.root, pair.x.random.root,
    ).context.currentQueryContext.state;
    ctx = newCircuitCtx(state, privateState, 1000);
    expect(() => (contract.impureCircuits as any).startTimeout(ctx, pair.gameId, 2000n))
      .toThrow(/game is not in progress/);
  });

  test("startTimeout may be re-armed while armed; the floor still applies to each arm", () => {
    // Documented behaviour: the waiter may extend the deadline (grant mercy),
    // but every re-arm must still satisfy the minimum grace.
    const pair = playersC();
    const { contract, privateState, state } = setup(pair);
    const s1 = settleChunk(contract, state, privateState, pair, 0, [P(0, 0)]);
    let ctx = newCircuitCtx(s1, secretPS(pair, "x"), 1000);
    const a1 = (contract.impureCircuits as any).startTimeout(ctx, pair.gameId, 2000n);
    let st = a1.context.currentQueryContext.state;
    expect(Number(dynOf(led(st), pair).deadline)).toBe(2000);
    // Re-arm with a later deadline — allowed.
    ctx = newCircuitCtx(st, secretPS(pair, "x"), 1100);
    const a2 = (contract.impureCircuits as any).startTimeout(ctx, pair.gameId, 3000n);
    st = a2.context.currentQueryContext.state;
    expect(Number(dynOf(led(st), pair).deadline)).toBe(3000);
    // Re-arm below the floor — rejected.
    ctx = newCircuitCtx(st, secretPS(pair, "x"), 1200);
    expect(() => (contract.impureCircuits as any).startTimeout(ctx, pair.gameId, 1700n))
      .toThrow(/timeout too short/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// MALFORMED-INPUT SUITE — for every circuit, assume the opponent sends bad data
// (out-of-range / non-canonical / forged) and confirm the guard rejects it.
// One test per distinct assert, grouped by circuit, mirroring the contract.
// ═════════════════════════════════════════════════════════════════════════════

// Thin wrappers so the proof-circuit calls below read clearly.
const call = (contract: any, name: string, ctx: any, ...args: any[]) =>
  (contract.impureCircuits as any)[name](ctx, ...args);

describe("malformed inputs: createGame / joinGame", () => {
  test("index / random root of zero rejected; a distinct joiner id required", () => {
    const pair = playersA();
    const fresh = playersB(); // its gameId is unused on this contract
    const { contract, privateState, state } = setup(pair);
    const Z = { field: 0n };
    expect(() => call(contract, "createGame", newCircuitCtx(state, privateState, 200),
      fresh.gameId, fresh.x.id, fresh.x.token.root, Z, fresh.x.random.root))
      .toThrow(/index root must not be zero/);
    expect(() => call(contract, "createGame", newCircuitCtx(state, privateState, 200),
      fresh.gameId, fresh.x.id, fresh.x.token.root, fresh.x.index.root, Z))
      .toThrow(/random root must not be zero/);
  });

  test("joinGame on a non-existent game is rejected", () => {
    const pair = playersA();
    const fresh = playersB();
    const { contract, privateState, state } = setup(pair);
    expect(() => call(contract, "joinGame", newCircuitCtx(state, privateState, 200),
      fresh.gameId, fresh.o.id, fresh.o.token.root, fresh.o.index.root, fresh.o.random.root))
      .toThrow(/no such game/);
  });

  test("joining an already-open game is rejected (double-join)", () => {
    const pair = playersA();
    const { contract, privateState, state } = setup(pair); // already created+joined
    expect(() => call(contract, "joinGame", newCircuitCtx(state, privateState, 300),
      pair.gameId, pair.o.id, pair.o.token.root, pair.o.index.root, pair.o.random.root))
      .toThrow(/game already open/);
  });
});

describe("malformed inputs: settle", () => {
  test("settle on a non-existent game is rejected", () => {
    const pair = playersA();
    const fresh = playersB();
    const { contract, privateState, state } = setup(pair);
    expect(() => settleChunk(contract, state, privateState, fresh, 0, [P(0, 0)]))
      .toThrow(/no such game/);
  });

  test("claimed class outside {0,1} is rejected", () => {
    const pair = playersC();
    const { contract, privateState, state } = setup(pair);
    const c = packChunk(pair, 0, [P(0, 0)]);
    c.parities[0] = 2n;
    expect(() => contract.impureCircuits.settle(
      newCircuitCtx(state, privateState, 1000),
      pair.gameId, c.nMoves, c.parities, c.kinds, c.cells, c.sizes, c.secrets, c.paths, 5000n,
    )).toThrow(/class must be 0 or 1/);
  });

  test("removing an empty cell is rejected", () => {
    const pair = playersB(); // turns 1,2 are remove-class
    const { contract, privateState, state } = setup(pair);
    // Turn 0 places at cell 0; turn 1 (O, remove) tries to remove empty cell 5.
    expect(() => settleChunk(contract, state, privateState, pair, 0, [P(0, 0), R(5)]))
      .toThrow(/cell is empty/);
  });

  test("a forged non-canonical REMOVE token (size≠0) is rejected", () => {
    const base = playersB();
    // O commits a token for (turn 1, remove, cell 0, SIZE 1) — non-canonical.
    const mal = buildMaliciousTokenTree(base.gameId, { turn: 1, kind: KIND_REMOVE, cell: 0, size: 1 });
    const pair: TestPair = { ...base, o: { ...base.o, token: { ...base.o.token, root: mal.root } } };
    const { contract, privateState, state } = setup(pair);
    const c = packChunk(pair, 0, [P(0, 0), R(0)]); // turn1 remove; override with the forged size-1 token
    c.sizes[1] = 1n;
    c.secrets[1] = mal.secret;
    c.paths[1] = mal.path;
    expect(() => contract.impureCircuits.settle(
      newCircuitCtx(state, privateState, 1000),
      pair.gameId, c.nMoves, c.parities, c.kinds, c.cells, c.sizes, c.secrets, c.paths, 5000n,
    )).toThrow(/remove uses canonical size 0/);
  });

  test("a forged non-canonical PASS token (cell≠0) is rejected", () => {
    const base = playersB();
    const mal = buildMaliciousTokenTree(base.gameId, { turn: 1, kind: KIND_PASS, cell: 5, size: 0 });
    const pair: TestPair = { ...base, o: { ...base.o, token: { ...base.o.token, root: mal.root } } };
    const { contract, privateState, state } = setup(pair);
    const c = packChunk(pair, 0, [P(0, 0), PASS]); // turn1 pass; override to cell 5 with the forged token
    c.cells[1] = 5n;
    c.secrets[1] = mal.secret;
    c.paths[1] = mal.path;
    expect(() => contract.impureCircuits.settle(
      newCircuitCtx(state, privateState, 1000),
      pair.gameId, c.nMoves, c.parities, c.kinds, c.cells, c.sizes, c.secrets, c.paths, 5000n,
    )).toThrow(/pass uses canonical cell 0, size 0/);
  });
});

describe("malformed inputs: fraud/dispute range + format guards", () => {
  // Range/format guards fire BEFORE any Merkle-path check, so dummy paths are fine.
  test("proveEquivocationByX: turn ≥ 128 rejected", () => {
    const pair = playersA();
    const { contract, privateState, state } = setup(pair);
    expect(() => call(contract, "proveEquivocationByX", newCircuitCtx(state, privateState, 1000),
      pair.gameId, 200n,
      1n, 0n, 0n, ZERO_BYTES32, pair.x.token.pathFor(0, KIND_PLACE, 0, 0),
      1n, 1n, 0n, ZERO_BYTES32, pair.x.token.pathFor(0, KIND_PLACE, 1, 0),
    )).toThrow(/turn out of range/);
  });

  test("proveIndexEquivocationByX: slot ≥ 16 and non-binary bits rejected", () => {
    const pair = playersA();
    const { contract, privateState, state } = setup(pair);
    expect(() => call(contract, "proveIndexEquivocationByX", newCircuitCtx(state, privateState, 1000),
      pair.gameId, 2n,
      99n, 0n, 0n, 0n, 0n, ZERO_BYTES32, ZERO_PATH_7,
      1n, 0n, 0n, 0n, 0n, ZERO_BYTES32, ZERO_PATH_7,
    )).toThrow(/slot out of range/);
    expect(() => call(contract, "proveIndexEquivocationByX", newCircuitCtx(state, privateState, 1000),
      pair.gameId, 2n,
      0n, 2n, 0n, 0n, 0n, ZERO_BYTES32, ZERO_PATH_7, // a0 = 2
      1n, 0n, 0n, 0n, 0n, ZERO_BYTES32, ZERO_PATH_7,
    )).toThrow(/A-bits must be 0 or 1/);
  });

  test("proveRandomEquivocationByX: turn / slot / bits out of range rejected", () => {
    const pair = playersA();
    const { contract, privateState, state } = setup(pair);
    expect(() => call(contract, "proveRandomEquivocationByX", newCircuitCtx(state, privateState, 1000),
      pair.gameId, 200n, 0n,
      0n, 0n, 0n, 0n, ZERO_BYTES32, ZERO_PATH_11,
      0n, 0n, 0n, 0n, ZERO_BYTES32, ZERO_PATH_11,
    )).toThrow(/turn out of range/);
    expect(() => call(contract, "proveRandomEquivocationByX", newCircuitCtx(state, privateState, 1000),
      pair.gameId, 2n, 99n,
      0n, 0n, 0n, 0n, ZERO_BYTES32, ZERO_PATH_11,
      0n, 0n, 0n, 0n, ZERO_BYTES32, ZERO_PATH_11,
    )).toThrow(/slot out of range/);
    expect(() => call(contract, "proveRandomEquivocationByX", newCircuitCtx(state, privateState, 1000),
      pair.gameId, 2n, 0n,
      2n, 0n, 0n, 0n, ZERO_BYTES32, ZERO_PATH_11, // a0 = 2
      0n, 0n, 0n, 0n, ZERO_BYTES32, ZERO_PATH_11,
    )).toThrow(/A-bits must be 0 or 1/);
  });

  test("proveWrongParity: turn ≥ 128 and slot ≥ 16 rejected (before commitment check)", () => {
    const pair = playersA();
    const { contract, privateState, state } = setup(pair);
    expect(() => call(contract, "proveWrongParity", newCircuitCtx(state, privateState, 1000),
      pair.gameId, 200n, 0n,
      0n, 0n, 0n, 0n, ZERO_BYTES32, ZERO_PATH_7,
      0n, 0n, 0n, 0n, ZERO_BYTES32, ZERO_PATH_11,
    )).toThrow(/turn out of range/);
    expect(() => call(contract, "proveWrongParity", newCircuitCtx(state, privateState, 1000),
      pair.gameId, 1n, 99n,
      0n, 0n, 0n, 0n, ZERO_BYTES32, ZERO_PATH_7,
      0n, 0n, 0n, 0n, ZERO_BYTES32, ZERO_PATH_11,
    )).toThrow(/slot out of range/);
  });

  test("proveWrongParity: non-binary bits on a committed turn rejected", () => {
    const pair = playersA();
    const { contract, privateState, state } = setup(pair);
    const s1 = settleChunk(contract, state, privateState, pair, 0, [P(0, 0), P(4, 0)]); // commit turns 0,1
    const it = intentFor(pair, 1);
    const rv = revealFor(pair, 1, it.slot);
    expect(() => call(contract, "proveWrongParity", newCircuitCtx(s1, privateState, 1200),
      pair.gameId, 1n, BigInt(it.slot),
      2n, 0n, 0n, 0n, it.secret, it.path, // I-bit = 2
      BigInt(rv.bits[0]), BigInt(rv.bits[1]), BigInt(rv.bits[2]), BigInt(rv.bits[3]), rv.random, rv.path,
    )).toThrow(/I-bits must be 0 or 1/);
  });

  test("answerRollChallenge: slot ≥ 16 and non-binary bits rejected", () => {
    const pair = playersA();
    const { contract, privateState, state } = setup(pair, pair.o.secret); // O challenges X's turn 2
    const s1 = settleChunk(contract, state, privateState, pair, 0, [P(2, 0), P(4, 0), P(0, 0)]);
    const ch = call(contract, "challengeRoll", newCircuitCtx(s1, privateState, 1100), pair.gameId, 2n, 1800n);
    const st = ch.context.currentQueryContext.state;
    expect(() => call(contract, "answerRollChallenge", newCircuitCtx(st, privateState, 1200),
      pair.gameId, 99n,
      0n, 0n, 0n, 0n, ZERO_BYTES32, ZERO_PATH_7,
      0n, 0n, 0n, 0n, ZERO_BYTES32, ZERO_PATH_11,
    )).toThrow(/slot out of range/);
    expect(() => call(contract, "answerRollChallenge", newCircuitCtx(st, privateState, 1200),
      pair.gameId, 0n,
      2n, 0n, 0n, 0n, ZERO_BYTES32, ZERO_PATH_7, // I-bit = 2
      0n, 0n, 0n, 0n, ZERO_BYTES32, ZERO_PATH_11,
    )).toThrow(/I-bits must be 0 or 1/);
  });
});

describe("malformed inputs: forged leaves & stale status", () => {
  test("proveEquivocationByX: a token not under the X root is rejected", () => {
    const pair = playersA();
    const { contract, privateState, state } = setup(pair);
    const t = 2;
    expect(() => call(contract, "proveEquivocationByX", newCircuitCtx(state, privateState, 1000),
      pair.gameId, BigInt(t),
      // A: a genuine X token for (place, 4, 0)
      1n, 4n, 0n, pair.x.token.secrets[t][4], pair.x.token.pathFor(t, KIND_PLACE, 4, 0),
      // B: a real tree POSITION but the wrong secret → recomputed leaf isn't under the root
      1n, 7n, 0n, ZERO_BYTES32, pair.x.token.pathFor(t, KIND_PLACE, 7, 0),
    )).toThrow(/token B is not a valid X token/);
  });

  test("proveWrongParity: an index reveal not under the mover's I-root is rejected", () => {
    const pair = playersA();
    const { contract, privateState, state } = setup(pair);
    const s1 = settleChunk(contract, state, privateState, pair, 0, [P(0, 0), P(4, 0)]); // commit 0,1
    const it = intentFor(pair, 1);
    const rv = revealFor(pair, 1, it.slot);
    expect(() => call(contract, "proveWrongParity", newCircuitCtx(s1, privateState, 1200),
      pair.gameId, 1n, BigInt(it.slot),
      BigInt(it.bits[0]), BigInt(it.bits[1]), BigInt(it.bits[2]), BigInt(it.bits[3]), ZERO_BYTES32, it.path, // wrong secretI
      BigInt(rv.bits[0]), BigInt(rv.bits[1]), BigInt(rv.bits[2]), BigInt(rv.bits[3]), rv.random, rv.path,
    )).toThrow(/index reveal is not under/);
  });

  test("a fraud proof on an already-finalised game is rejected", () => {
    const pair = playersC();
    const { contract, privateState, state } = setup(pair);
    const s1 = settleChunk(contract, state, privateState, pair, 0, WIN_X, { time: 1000, until: 2000n });
    const fin = call(contract, "claimResult", newCircuitCtx(s1, privateState, 2500), pair.gameId, RECIP);
    const settled = fin.context.currentQueryContext.state; // status == settled now
    const t = 2;
    expect(() => call(contract, "proveEquivocationByX", newCircuitCtx(settled, privateState, 2600),
      pair.gameId, BigInt(t),
      1n, 4n, 0n, pair.x.token.secrets[t][4], pair.x.token.pathFor(t, KIND_PLACE, 4, 0),
      1n, 5n, 0n, pair.x.token.secrets[t][5], pair.x.token.pathFor(t, KIND_PLACE, 5, 0),
    )).toThrow(/already settled/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Settle variants: settle2 / settle16 (one generic settleImpl<#N>, monomorphic
// entry points). Every rule assert lives in the shared generic body, so each
// variant must behave exactly like `settle` — these tests pin that down, plus
// the per-variant nMoves bound.
// ─────────────────────────────────────────────────────────────────────────────

// All-place 16-move script for playersC (X even turns / O odd): X fills
// 0,1,2,4,5,6,8,9 (never 4 in a line); O fills 3,7,11,12,13,14,10,15 — the
// FINAL move (turn 15, cell 15) completes row3 {12,13,14,15} AND col3
// {3,7,11,15}, so O wins exactly on the chunk's last move.
const SIXTEEN: ScriptMove[] = SIXTEEN_C;

function settleVariant(
  contract: any,
  state: any,
  privateState: any,
  pair: TestPair,
  baseTurn: number,
  moves: ScriptMove[],
  variant: 2 | 8 | 16,
  opts: { time?: number; until?: bigint; nMovesOverride?: bigint } = {},
) {
  const c = packChunk(pair, baseTurn, moves, variant);
  if (opts.nMovesOverride !== undefined) c.nMoves = opts.nMovesOverride;
  const name = variant === 8 ? "settle" : `settle${variant}`;
  const ctx = newCircuitCtx(state, privateState, opts.time ?? 1000);
  const res = call(contract, name, ctx, pair.gameId, c.nMoves, c.parities, c.kinds, c.cells, c.sizes, c.secrets, c.paths, opts.until ?? 5000n);
  return res.context.currentQueryContext.state;
}

describe("settle variants: settle2 / settle16", () => {
  test("settle2 commits a 2-move chunk", () => {
    const pair = playersC();
    const { contract, privateState, state } = setup(pair);
    const s1 = settleVariant(contract, state, privateState, pair, 0, SIXTEEN.slice(0, 2), 2);
    const l = led(s1);
    expect(Number(dynOf(l, pair).committedTurns)).toBe(2);
    expect(topAt(l, pair, 0)).toBe(1); // X on cell 0
    expect(topAt(l, pair, 3)).toBe(2); // O on cell 3
  });

  test("settle2 commits a padded 1-move tail after a full settle(8)", () => {
    const pair = playersC();
    const { contract, privateState, state } = setup(pair);
    const s1 = settleChunk(contract, state, privateState, pair, 0, SIXTEEN.slice(0, 8), { time: 1000 });
    const s2 = settleVariant(contract, s1, privateState, pair, 8, SIXTEEN.slice(8, 9), 2, { time: 1100 });
    const l = led(s2);
    expect(Number(dynOf(l, pair).committedTurns)).toBe(9);
    expect(topAt(l, pair, 5)).toBe(1); // turn 8: X on cell 5
  });

  test("settle16 commits 16 moves in ONE call, win landing on the final move", () => {
    const pair = playersC();
    const { contract, privateState, state } = setup(pair);
    const s1 = settleVariant(contract, state, privateState, pair, 0, SIXTEEN, 16);
    const d = dynOf(led(s1), pair);
    expect(Number(d.committedTurns)).toBe(16);
    expect(d.winner).toBe(Winner.o); // row3 + col3 complete at turn 15
  });

  test("settle16 result is identical to the same moves via two settle(8) calls", () => {
    const pair = playersC();
    const a = setup(pair);
    const b = setup(pair);
    const via16 = settleVariant(a.contract, a.state, a.privateState, pair, 0, SIXTEEN, 16);
    const via8 = settleChunk(b.contract, b.state, b.privateState, pair, 0, SIXTEEN, { time: 1000 });
    const l16 = led(via16);
    const l8 = led(via8);
    expect(Number(dynOf(l16, pair).committedTurns)).toBe(Number(dynOf(l8, pair).committedTurns));
    expect(dynOf(l16, pair).winner).toBe(dynOf(l8, pair).winner);
    for (let c = 0; c < 16; c++) expect(topAt(l16, pair, c)).toBe(topAt(l8, pair, c));
    // Same packed action log entry per turn.
    for (let t = 0; t < 16; t++) {
      expect(Number(l16.actionLogs.lookup(pair.gameId).lookup(BigInt(t))))
        .toBe(Number(l8.actionLogs.lookup(pair.gameId).lookup(BigInt(t))));
    }
  });

  test("settle2 rejects nMoves above its size (chunk too large)", () => {
    const pair = playersC();
    const { contract, privateState, state } = setup(pair);
    expect(() =>
      settleVariant(contract, state, privateState, pair, 0, SIXTEEN.slice(0, 2), 2, { nMovesOverride: 3n }),
    ).toThrow(/chunk too large/);
  });

  test("settle16 rejects an empty chunk", () => {
    const pair = playersC();
    const { contract, privateState, state } = setup(pair);
    expect(() =>
      settleVariant(contract, state, privateState, pair, 0, [], 16, { nMovesOverride: 0n }),
    ).toThrow(/empty chunk/);
  });

  test("rule asserts live in every variant: bad token path rejected by settle16", () => {
    const pair = playersC();
    const { contract, privateState, state } = setup(pair);
    const c = packChunk(pair, 0, SIXTEEN.slice(0, 2), 16);
    c.paths[0] = pair.x.token.pathFor(0, KIND_PLACE, 1, 0); // path for a DIFFERENT action
    const ctx = newCircuitCtx(state, privateState, 1000);
    expect(() =>
      call(contract, "settle16", ctx, pair.gameId, c.nMoves, c.parities, c.kinds, c.cells, c.sizes, c.secrets, c.paths, 5000n),
    ).toThrow(/invalid one-time token/);
  });

  test("rule asserts live in every variant: class lie rejected by settle2", () => {
    const pair = playersC();
    const { contract, privateState, state } = setup(pair);
    const lied: ScriptMove[] = [{ kind: KIND_PLACE, cell: 0, size: 0, lieParity: 0 }];
    expect(() =>
      settleVariant(contract, state, privateState, pair, 0, lied, 2),
    ).toThrow(/action kind inconsistent/);
  });

  test("challenge-window floor applies to settle2", () => {
    const pair = playersC();
    const { contract, privateState, state } = setup(pair);
    // blockTime 1000, until 1500: 1500 - 600 = 900 < 1000 → too short.
    expect(() =>
      settleVariant(contract, state, privateState, pair, 0, SIXTEEN.slice(0, 2), 2, { time: 1000, until: 1500n }),
    ).toThrow(/challenge window too short/);
  });
});
