// Contract-only simulation tests — drive the compiled Circuits in pure JS
// via @midnight-ntwrk/compact-runtime, no proof generation, no chain.
// Verifies state transitions of: openChannel, settle (incl. override), the
// fraud-proof equivocation circuits, the timeout flow, and key negatives.

import { describe, test, expect } from "vitest";
import {
  createConstructorContext,
  createCircuitContext,
  type CircuitContext,
} from "@midnight-ntwrk/compact-runtime";

import { Contract, ledger, Status, Winner } from "../src/contract/managed/contract/index.js";
import { createWitnesses, createTicTacToePrivateState } from "../src/contract/witnesses.ts";
import { buildTokenTree, type TokenTree, type MerklePath } from "../src/sdk/crypto/token-tree.ts";
import { computePlayerId, computeTokenLeaf, merklePathRootField, randomBytes32 } from "../src/sdk/crypto/persistent-hash.ts";

// Deterministic RNG for reproducibility.
let rngSeed = 1n;
const detRng = (): Uint8Array => {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    rngSeed = (rngSeed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
    out[i] = Number((rngSeed >> 16n) & 0xffn);
  }
  return out;
};
function resetRng() { rngSeed = 1n; }

// ── Helpers ────────────────────────────────────────────────────────────────

const ZERO_BYTES = new Uint8Array(32);
const ZERO_PATH: MerklePath = {
  leaf: ZERO_BYTES,
  path: Array.from({ length: 10 }, () => ({ sibling: { field: 0n }, goes_left: false })),
};
const ZERO_KEY = new Uint8Array(32);
const CONTRACT_ADDR = "0".repeat(64);

function newPlayer(rng: () => Uint8Array) {
  const secret = rng();
  const id = computePlayerId(secret);
  const tree = buildTokenTree(rng);
  return { secret, id, tree };
}

function pack9<T>(values: T[], pad: T): T[] {
  const out = new Array<T>(9);
  for (let i = 0; i < 9; i++) out[i] = i < values.length ? values[i] : pad;
  return out;
}

type PlayerKeys = { secret: Uint8Array; id: Uint8Array; tree: TokenTree };

function setup(opts: { rng?: () => Uint8Array; playerSecret?: Uint8Array } = {}) {
  resetRng();
  const rng = opts.rng ?? detRng;
  const x = newPlayer(rng);
  const o = newPlayer(rng);
  const playerSecret = opts.playerSecret ?? x.secret;
  const privateState = createTicTacToePrivateState(playerSecret);
  const contract = new Contract(createWitnesses() as any);

  const ctorCtx = createConstructorContext(privateState, ZERO_KEY as any);
  const halfOpenInit = contract.initialState(ctorCtx, x.id, x.tree.root);

  // Drive the two-phase open: simulate O calling joinChannel right after
  // the deploy so all downstream tests can assume status = inProgress.
  const joinCtx = newCircuitCtx(halfOpenInit.currentContractState, halfOpenInit.currentPrivateState, 100);
  const joined = (contract.impureCircuits as any).joinChannel(joinCtx, o.id, o.tree.root);
  // The next newCircuitCtx wants a contractState — pass the raw post-join
  // state (createCircuitContext accepts ContractState | StateValue | ChargedState).
  const init = {
    currentContractState: joined.context.currentQueryContext.state,
    currentPrivateState: joined.context.currentPrivateState,
    currentZswapLocalState: joined.context.currentZswapLocalState,
  } as any;

  return { contract, x, o, privateState, init };
}

function newCircuitCtx<PS>(
  contractState: any,
  privateState: PS,
  time?: number,
): CircuitContext<PS> {
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

function moves(
  x: PlayerKeys,
  o: PlayerKeys,
  cells: number[],
): { cells: bigint[]; secrets: Uint8Array[]; paths: MerklePath[]; nMoves: bigint } {
  const c: bigint[] = [];
  const s: Uint8Array[] = [];
  const p: MerklePath[] = [];
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    const player = i % 2 === 0 ? x : o;
    c.push(BigInt(cell));
    s.push(player.tree.secrets[i][cell]);
    p.push(player.tree.pathFor(i, cell));
  }
  return {
    cells: pack9(c, 0n),
    secrets: pack9(s, ZERO_BYTES),
    paths: pack9(p, ZERO_PATH),
    nMoves: BigInt(cells.length),
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("openChannel", () => {
  test("initial state has both ids/roots, status=inProgress, winner=none", () => {
    const { init, x, o } = setup();
    const led = ledger(init.currentContractState);
    expect(Buffer.from(led.idX)).toEqual(Buffer.from(x.id));
    expect(Buffer.from(led.idO)).toEqual(Buffer.from(o.id));
    expect(led.rootX.field).toBe(x.tree.root.field);
    expect(led.rootO.field).toBe(o.tree.root.field);
    expect(led.status).toBe(Status.inProgress);
    expect(led.winner).toBe(Winner.none);
    expect(led.turnMark).toBe(1n);
    expect(led.committedTurns).toBe(0n);
    expect(led.hasDeadline).toBe(false);
    expect(led.hasChallenge).toBe(false);
  });
});

describe("crypto parity (token tree vs in-circuit verification)", () => {
  test("a TS-built path verifies under the in-circuit tokenIsUnder (via settle)", () => {
    const { contract, x, o, init, privateState } = setup();
    const m = moves(x, o, [4]);

    const ctx = newCircuitCtx(init.currentContractState, privateState, 1000);
    // settle one X move at cell 4. If the leaf/root algorithm diverges
    // between TS and Compact, this would fail with
    // "invalid one-time token for this (turn, cell)".
    const result = contract.impureCircuits.settle(
      ctx,
      m.nMoves, m.cells, m.secrets, m.paths,
      2000n, // challenge until
    );
    const led = ledger(result.context.currentQueryContext.state);
    expect(led.board.member(4n)).toBe(true);
    expect(led.board.lookup(4n)).toBe(1n);
    expect(led.committedTurns).toBe(1n);
  });

  test("TS-computed root for an arbitrary path matches the stored root", () => {
    const { x } = setup();
    for (const [t, c] of [[0, 0], [4, 7], [8, 8]] as [number, number][]) {
      const p = x.tree.pathFor(t, c);
      const leaf = computeTokenLeaf(t, c, x.tree.secrets[t][c]);
      expect(Buffer.from(p.leaf)).toEqual(Buffer.from(leaf));
      const root = merklePathRootField(p.leaf, p.path);
      expect(root).toBe(x.tree.root.field);
    }
  });
});

describe("settle (happy path)", () => {
  test("X wins top row -> winner=x, committedTurns=5", () => {
    const { contract, x, o, init, privateState } = setup();
    // X:0, O:3, X:1, O:4, X:2 -> X completes top row
    const m = moves(x, o, [0, 3, 1, 4, 2]);
    const ctx = newCircuitCtx(init.currentContractState, privateState, 1000);
    const res = contract.impureCircuits.settle(ctx, m.nMoves, m.cells, m.secrets, m.paths, 5000n);
    const led = ledger(res.context.currentQueryContext.state);
    expect(led.winner).toBe(Winner.x);
    expect(led.committedTurns).toBe(5n);
    expect(led.hasChallenge).toBe(true);
    expect(led.challengeUntil).toBe(5000n);
  });

  test("Draw -> winner=draw after 9 moves", () => {
    const { contract, x, o, init, privateState } = setup();
    // A known drawing sequence (no winner; full board):
    //  X:0 O:1 X:2 O:4 X:3 O:5 X:7 O:6 X:8
    const m = moves(x, o, [0, 1, 2, 4, 3, 5, 7, 6, 8]);
    const ctx = newCircuitCtx(init.currentContractState, privateState, 1000);
    const res = contract.impureCircuits.settle(ctx, m.nMoves, m.cells, m.secrets, m.paths, 5000n);
    const led = ledger(res.context.currentQueryContext.state);
    expect(led.winner).toBe(Winner.draw);
    expect(led.committedTurns).toBe(9n);
  });

  test("claimResult after challenge window finalises", () => {
    const { contract, x, o, init, privateState } = setup();
    const m = moves(x, o, [0, 3, 1, 4, 2]);
    let ctx = newCircuitCtx(init.currentContractState, privateState, 1000);
    const after = contract.impureCircuits.settle(ctx, m.nMoves, m.cells, m.secrets, m.paths, 1500n);
    ctx = newCircuitCtx(after.context.currentQueryContext.state, after.context.currentPrivateState, 2000);
    const final = contract.impureCircuits.claimResult(ctx);
    const led = ledger(final.context.currentQueryContext.state);
    expect(led.status).toBe(Status.settled);
    expect(led.winner).toBe(Winner.x);
  });
});

describe("settle (override)", () => {
  test("longer history wins; shorter is rejected", () => {
    const { contract, x, o, init, privateState } = setup();
    // First settle: 3 moves, no winner.
    const m1 = moves(x, o, [0, 3, 1]);
    let ctx = newCircuitCtx(init.currentContractState, privateState, 1000);
    const r1 = contract.impureCircuits.settle(ctx, m1.nMoves, m1.cells, m1.secrets, m1.paths, 5000n);
    expect(ledger(r1.context.currentQueryContext.state).committedTurns).toBe(3n);

    // Second settle: 5 moves extending the first — must be a true extension
    // (same prefix), the contract checks via the !member assert.
    const m2 = moves(x, o, [0, 3, 1, 4, 2]);
    ctx = newCircuitCtx(r1.context.currentQueryContext.state, r1.context.currentPrivateState, 1100);
    const r2 = contract.impureCircuits.settle(ctx, m2.nMoves, m2.cells, m2.secrets, m2.paths, 5500n);
    expect(ledger(r2.context.currentQueryContext.state).committedTurns).toBe(5n);
    expect(ledger(r2.context.currentQueryContext.state).winner).toBe(Winner.x);

    // Third settle: nMoves == committedTurns is rejected (must strictly extend).
    ctx = newCircuitCtx(r2.context.currentQueryContext.state, r2.context.currentPrivateState, 1200);
    expect(() =>
      contract.impureCircuits.settle(ctx, m1.nMoves, m1.cells, m1.secrets, m1.paths, 6000n)
    ).toThrow(/strictly extend|committed history/);
  });

  test("override that contradicts the prior placement is rejected", () => {
    const { contract, x, o, init, privateState } = setup();
    const m1 = moves(x, o, [0, 3, 1]);   // X:0, O:3, X:1
    let ctx = newCircuitCtx(init.currentContractState, privateState, 1000);
    const r1 = contract.impureCircuits.settle(ctx, m1.nMoves, m1.cells, m1.secrets, m1.paths, 5000n);

    // Contradictory: turn 0 X plays cell 2 instead of cell 0.
    const m2 = moves(x, o, [2, 3, 0, 4, 1]);
    ctx = newCircuitCtx(r1.context.currentQueryContext.state, r1.context.currentPrivateState, 1100);
    expect(() =>
      contract.impureCircuits.settle(ctx, m2.nMoves, m2.cells, m2.secrets, m2.paths, 5500n)
    ).toThrow(/cell already taken/);
  });
});

describe("equivocation fraud proof", () => {
  test("two X tokens at the same turn but different cells -> O wins instantly", () => {
    const { contract, x, init, privateState } = setup();

    // Equivocation pair: turn 2 (third move, X), cells 4 and 5 — both valid X tokens.
    const turn = 2;
    const cellA = 4, cellB = 5;
    const pathA = x.tree.pathFor(turn, cellA);
    const pathB = x.tree.pathFor(turn, cellB);

    const ctx = newCircuitCtx(init.currentContractState, privateState, 1000);
    const res = contract.impureCircuits.proveEquivocationByX(
      ctx,
      BigInt(turn),
      BigInt(cellA), x.tree.secrets[turn][cellA], pathA,
      BigInt(cellB), x.tree.secrets[turn][cellB], pathB,
    );
    const led = ledger(res.context.currentQueryContext.state);
    expect(led.winner).toBe(Winner.o);
    expect(led.status).toBe(Status.settled);
  });

  test("same-cell 'equivocation' rejected", () => {
    const { contract, x, init, privateState } = setup();
    const turn = 2;
    const cell = 4;
    const path = x.tree.pathFor(turn, cell);
    const ctx = newCircuitCtx(init.currentContractState, privateState, 1000);
    expect(() =>
      contract.impureCircuits.proveEquivocationByX(
        ctx,
        BigInt(turn),
        BigInt(cell), x.tree.secrets[turn][cell], path,
        BigInt(cell), x.tree.secrets[turn][cell], path,
      )
    ).toThrow(/same cell/);
  });
});

describe("timeout", () => {
  test("startTimeout + claimTimeout: O times out -> X wins", () => {
    const { contract, x, o, init, privateState } = setup();
    // Play one move: X:0. Now it's O's turn (turnMark=2). X (the waiting player)
    // arms a timeout, then claimTimeout fires after the deadline passes.
    const m = moves(x, o, [0]);
    let ctx = newCircuitCtx(init.currentContractState, privateState, 1000);
    const r = contract.impureCircuits.settle(ctx, m.nMoves, m.cells, m.secrets, m.paths, 5000n);
    expect(ledger(r.context.currentQueryContext.state).turnMark).toBe(2n);

    // X arms a deadline at time=2000. Caller must be the *waiting* player (X here).
    ctx = newCircuitCtx(r.context.currentQueryContext.state, r.context.currentPrivateState, 1100);
    const armed = contract.impureCircuits.startTimeout(ctx, 2000n);
    expect(ledger(armed.context.currentQueryContext.state).hasDeadline).toBe(true);

    // Try claimTimeout before deadline -> fail.
    ctx = newCircuitCtx(armed.context.currentQueryContext.state, armed.context.currentPrivateState, 1500);
    expect(() => contract.impureCircuits.claimTimeout(ctx)).toThrow(/deadline has not been reached/);

    // Past deadline -> claimTimeout flips winner to X.
    ctx = newCircuitCtx(armed.context.currentQueryContext.state, armed.context.currentPrivateState, 2500);
    const claimed = contract.impureCircuits.claimTimeout(ctx);
    const led = ledger(claimed.context.currentQueryContext.state);
    expect(led.winner).toBe(Winner.x);
    expect(led.status).toBe(Status.settled);
  });

  test("startTimeout by the player-to-move is rejected", () => {
    const { contract, x, o, init, privateState } = setup();
    const m = moves(x, o, [0]); // now it's O's turn
    let ctx = newCircuitCtx(init.currentContractState, privateState, 1000);
    const r = contract.impureCircuits.settle(ctx, m.nMoves, m.cells, m.secrets, m.paths, 5000n);
    // We need O's secret to attempt this fraud (which proves callerMark=O).
    const oPrivate = createTicTacToePrivateState(o.secret);
    ctx = newCircuitCtx(r.context.currentQueryContext.state, oPrivate, 1100);
    expect(() => contract.impureCircuits.startTimeout(ctx, 2000n)).toThrow(/only the waiting player/);
  });
});

describe("negatives", () => {
  test("settle rejects a token under the wrong root (fabricated move)", () => {
    const { contract, x, o, init, privateState } = setup();
    // Use one of O's tokens for X's turn 0.
    const cells = pack9<bigint>([4n], 0n);
    const secrets = pack9<Uint8Array>([o.tree.secrets[0][4]], ZERO_BYTES);
    const paths = pack9<MerklePath>([o.tree.pathFor(0, 4)], ZERO_PATH);
    const ctx = newCircuitCtx(init.currentContractState, privateState, 1000);
    expect(() =>
      contract.impureCircuits.settle(ctx, 1n, cells, secrets, paths, 5000n)
    ).toThrow(/invalid one-time token|invalid|token/i);
  });

  test("settle rejects cell out of range", () => {
    const { contract, x, init, privateState } = setup();
    const cells = pack9<bigint>([42n], 0n);
    const secrets = pack9<Uint8Array>([x.tree.secrets[0][0]], ZERO_BYTES);
    const paths = pack9<MerklePath>([x.tree.pathFor(0, 0)], ZERO_PATH);
    const ctx = newCircuitCtx(init.currentContractState, privateState, 1000);
    expect(() =>
      contract.impureCircuits.settle(ctx, 1n, cells, secrets, paths, 5000n)
    ).toThrow(/cell out of range/);
  });
});
