// Crypto module tests — token tree, SignedMove build/verify, equivocation builder.
// No contract / chain involved; just the TS primitives.

import { describe, test, expect } from "vitest";
import {
  computePlayerId,
  computeTokenLeaf,
  merklePathRootField,
  randomBytes32,
} from "../src/sdk/crypto/persistent-hash.ts";
import { buildTokenTree, TURNS, CELLS } from "../src/sdk/crypto/token-tree.ts";
import {
  applyMove,
  buildEquivocationProof,
  detectWinner,
  hashSignedMove,
  isMyTurn,
  verifySignedMove,
  type SignedMove,
} from "../src/sdk/crypto/signed-move.ts";
import { encodeMove, decodeMove, stringifyMove, parseMove } from "../src/sdk/game/messaging.ts";

// Deterministic RNG so test failures are reproducible.
let seed = 100n;
const detRng = (): Uint8Array => {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
    out[i] = Number((seed >> 16n) & 0xffn);
  }
  return out;
};
function resetRng() { seed = 100n; }

describe("playerId", () => {
  test("is 32 bytes and deterministic", () => {
    const sk = new Uint8Array(32);
    sk[0] = 1;
    const a = computePlayerId(sk);
    const b = computePlayerId(sk);
    expect(a.length).toBe(32);
    expect(Buffer.from(a)).toEqual(Buffer.from(b));
  });
  test("different secrets -> different ids", () => {
    const a = new Uint8Array(32); a[0] = 1;
    const b = new Uint8Array(32); b[0] = 2;
    expect(Buffer.from(computePlayerId(a))).not.toEqual(Buffer.from(computePlayerId(b)));
  });
});

describe("token tree", () => {
  test("every (turn, cell) path verifies against the stored root", () => {
    resetRng();
    const tree = buildTokenTree(detRng);
    for (let t = 0; t < TURNS; t++) {
      for (let c = 0; c < CELLS; c++) {
        const path = tree.pathFor(t, c);
        // Leaf is the TokenPreimage hash of (turn, cell, secret).
        const expectedLeaf = computeTokenLeaf(t, c, tree.secrets[t][c]);
        expect(Buffer.from(path.leaf)).toEqual(Buffer.from(expectedLeaf));
        // Path verifies to the same root.
        const derived = merklePathRootField(path.leaf, path.path);
        expect(derived).toBe(tree.root.field);
      }
    }
  });

  test("a path with the wrong secret does not verify", () => {
    resetRng();
    const tree = buildTokenTree(detRng);
    const path = tree.pathFor(3, 4);
    const wrongLeaf = computeTokenLeaf(3, 4, randomBytes32());
    const derived = merklePathRootField(wrongLeaf, path.path);
    expect(derived).not.toBe(tree.root.field);
  });
});

describe("SignedMove verification", () => {
  function setupGame() {
    resetRng();
    const xSecret = detRng();
    const xTree = buildTokenTree(detRng);
    const oSecret = detRng();
    const oTree = buildTokenTree(detRng);
    return { x: { secret: xSecret, id: computePlayerId(xSecret), tree: xTree },
             o: { secret: oSecret, id: computePlayerId(oSecret), tree: oTree } };
  }

  function makeMove(turn: number, cell: number, mover: "x" | "o", players: ReturnType<typeof setupGame>, prev: SignedMove | null): SignedMove {
    const player = mover === "x" ? players.x : players.o;
    const mark = mover === "x" ? 1 as 1 : 2 as 2;
    const boardBefore = prev ? prev.boardAfter : new Uint8Array(9);
    const boardAfter = applyMove(boardBefore, cell, mark);
    const prevHash = prev ? hashSignedMove(prev) : new Uint8Array(32);
    return {
      channelId: "0xtest",
      turn, cell, boardAfter, prevHash,
      token: { secret: player.tree.secrets[turn][cell], path: player.tree.pathFor(turn, cell) },
    };
  }

  test("honest moves verify", () => {
    const p = setupGame();
    const m1 = makeMove(0, 0, "x", p, null);
    const m2 = makeMove(1, 3, "o", p, m1);
    const m3 = makeMove(2, 1, "x", p, m2);

    expect(verifySignedMove(m1, null, p.x.tree.root.field).ok).toBe(true);
    expect(verifySignedMove(m2, m1, p.o.tree.root.field).ok).toBe(true);
    expect(verifySignedMove(m3, m2, p.x.tree.root.field).ok).toBe(true);
  });

  test("verifying X's move under O's root fails (wrong-root rejection)", () => {
    const p = setupGame();
    const m = makeMove(0, 0, "x", p, null);
    const r = verifySignedMove(m, null, p.o.tree.root.field);
    expect(r.ok).toBe(false);
  });

  test("replay with wrong prev breaks the hash-link", () => {
    const p = setupGame();
    const m1 = makeMove(0, 0, "x", p, null);
    const m2 = makeMove(1, 3, "o", p, m1);
    // Verify m2 against a wrong "prev".
    const bogusPrev = { ...m1, cell: 7 };
    const r = verifySignedMove(m2, bogusPrev, p.o.tree.root.field);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/hash-link/);
  });

  test("a tampered boardAfter fails", () => {
    const p = setupGame();
    const m1 = makeMove(0, 0, "x", p, null);
    const tampered = { ...m1, boardAfter: new Uint8Array(9) };
    const r = verifySignedMove(tampered, null, p.x.tree.root.field);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/board/i);
  });

  test("non-zero first prevHash fails", () => {
    const p = setupGame();
    const m1 = makeMove(0, 0, "x", p, null);
    const bad = { ...m1, prevHash: Uint8Array.from({ length: 32 }, (_, i) => i) };
    const r = verifySignedMove(bad, null, p.x.tree.root.field);
    expect(r.ok).toBe(false);
  });
});

describe("equivocation proof builder", () => {
  test("succeeds when the same player produces 2 moves at the same turn, different cells", () => {
    resetRng();
    const xSecret = detRng();
    const xTree = buildTokenTree(detRng);
    const turn = 2;
    const mkMoveAt = (cell: number): SignedMove => ({
      channelId: "0xtest",
      turn,
      cell,
      boardAfter: new Uint8Array(9),
      prevHash: new Uint8Array(32),
      token: { secret: xTree.secrets[turn][cell], path: xTree.pathFor(turn, cell) },
    });
    const a = mkMoveAt(4);
    const b = mkMoveAt(5);
    const proof = buildEquivocationProof(a, b);
    expect(proof.turn).toBe(2);
    expect(proof.cellA).toBe(4);
    expect(proof.cellB).toBe(5);
    expect(Buffer.from(proof.secretA)).toEqual(Buffer.from(xTree.secrets[2][4]));
    expect(Buffer.from(proof.secretB)).toEqual(Buffer.from(xTree.secrets[2][5]));
    void xSecret;
  });

  test("rejects same-cell pair", () => {
    resetRng();
    const xTree = buildTokenTree(detRng);
    const mkMoveAt = (cell: number): SignedMove => ({
      channelId: "0xtest", turn: 2, cell,
      boardAfter: new Uint8Array(9), prevHash: new Uint8Array(32),
      token: { secret: xTree.secrets[2][cell], path: xTree.pathFor(2, cell) },
    });
    const a = mkMoveAt(4);
    const b = mkMoveAt(4);
    expect(() => buildEquivocationProof(a, b)).toThrow(/same cell/);
  });

  test("rejects different-turn pair", () => {
    resetRng();
    const xTree = buildTokenTree(detRng);
    const mkMoveAt = (turn: number, cell: number): SignedMove => ({
      channelId: "0xtest", turn, cell,
      boardAfter: new Uint8Array(9), prevHash: new Uint8Array(32),
      token: { secret: xTree.secrets[turn][cell], path: xTree.pathFor(turn, cell) },
    });
    const a = mkMoveAt(2, 4);
    const b = mkMoveAt(4, 5);
    expect(() => buildEquivocationProof(a, b)).toThrow(/turns differ/);
  });
});

describe("messaging (SignedMove JSON serde)", () => {
  test("round-trips byte-perfectly", () => {
    resetRng();
    const tree = buildTokenTree(detRng);
    const m: SignedMove = {
      channelId: "0xfeed",
      turn: 0,
      cell: 4,
      boardAfter: Uint8Array.from([0, 0, 0, 0, 1, 0, 0, 0, 0]),
      prevHash: new Uint8Array(32),
      token: { secret: tree.secrets[0][4], path: tree.pathFor(0, 4) },
    };
    const w = encodeMove(m);
    const back = decodeMove(w);
    expect(back.channelId).toBe(m.channelId);
    expect(back.turn).toBe(m.turn);
    expect(back.cell).toBe(m.cell);
    expect(Buffer.from(back.boardAfter)).toEqual(Buffer.from(m.boardAfter));
    expect(Buffer.from(back.prevHash)).toEqual(Buffer.from(m.prevHash));
    expect(Buffer.from(back.token.secret)).toEqual(Buffer.from(m.token.secret));
    expect(Buffer.from(back.token.path.leaf)).toEqual(Buffer.from(m.token.path.leaf));
    for (let i = 0; i < m.token.path.path.length; i++) {
      expect(back.token.path.path[i].sibling.field).toBe(m.token.path.path[i].sibling.field);
      expect(back.token.path.path[i].goes_left).toBe(m.token.path.path[i].goes_left);
    }
    // String form also round-trips.
    const s = stringifyMove(m);
    const parsed = parseMove(s);
    expect(parsed.channelId).toBe(m.channelId);
  });
});

describe("board helpers", () => {
  test("isMyTurn parity", () => {
    expect(isMyTurn(0, "x")).toBe(true);
    expect(isMyTurn(1, "x")).toBe(false);
    expect(isMyTurn(2, "x")).toBe(true);
    expect(isMyTurn(1, "o")).toBe(true);
    expect(isMyTurn(8, "o")).toBe(false);
  });

  test("detectWinner recognises rows/cols/diagonals", () => {
    const b = (s: string) => Uint8Array.from(s.split("").map(Number));
    expect(detectWinner(b("111000000"))).toBe(1);
    expect(detectWinner(b("000222000"))).toBe(2);
    expect(detectWinner(b("100100100"))).toBe(1);
    expect(detectWinner(b("100010001"))).toBe(1);
    expect(detectWinner(b("210012120"))).toBe(0);
    expect(detectWinner(b("121212212"))).toBe("draw");
  });
});
