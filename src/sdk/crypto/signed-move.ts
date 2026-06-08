// Off-chain SignedMove — exchanged peer-to-peer between players.
//
// A move authorises a specific (turn, cell) for the moving player by REVEALING
// the corresponding one-time-token secret. The receiver verifies the secret
// produces a leaf under the mover's token-tree root.
//
// Hash-link: each move includes the hash of the previous move (zero for the
// first). This prevents replaying a move into a different history.

import { computeTokenLeaf, hashBytes, merklePathRootField } from "./persistent-hash.ts";
import type { MerklePath } from "./token-tree.ts";

export type SignedMove = {
  channelId: string;            // contract address — domain separates per-game
  turn: number;                 // 0..8
  cell: number;                 // 0..8
  boardAfter: Uint8Array;       // length 9; cell -> mark (0=empty,1=X,2=O)
  prevHash: Uint8Array;         // 32 bytes; zero on first move
  token: {
    secret: Uint8Array;         // 32 bytes
    path: MerklePath;
  };
};

// Canonical encoding of a SignedMove for the hash-link. We do NOT include the
// merkle path: only the parts that the chain agrees on (channel, turn, cell,
// boardAfter, prevHash, token.secret). The token secret is included so the
// chain link binds to the specific authorising token.
export function encodeForChain(m: SignedMove): Uint8Array {
  const enc = new TextEncoder();
  const cid = enc.encode(m.channelId);
  const idHash = new Uint8Array(32);
  idHash.set(cid.subarray(0, Math.min(cid.length, 32)));
  const turnCell = new Uint8Array(32);
  turnCell[0] = m.turn & 0xff;
  turnCell[1] = m.cell & 0xff;
  const boardPadded = new Uint8Array(32);
  boardPadded.set(m.boardAfter.subarray(0, 9));
  return concat(idHash, turnCell, boardPadded, m.prevHash, m.token.secret);
}

export function hashSignedMove(m: SignedMove): Uint8Array {
  return hashBytes(encodeForChain(m));
}

export function isMyTurn(turn: number, iAm: "x" | "o"): boolean {
  // turn 0,2,4,... -> X; turn 1,3,5,... -> O
  return (turn % 2 === 0) === (iAm === "x");
}

export function nextTurnAfter(turn: number): number {
  return turn + 1;
}

export function applyMove(boardBefore: Uint8Array, cell: number, mark: 1 | 2): Uint8Array {
  if (boardBefore.length !== 9) throw new Error("board must be 9 cells");
  if (cell < 0 || cell > 8) throw new Error("cell out of range");
  if (boardBefore[cell] !== 0) throw new Error(`cell ${cell} already occupied`);
  const next = new Uint8Array(boardBefore);
  next[cell] = mark;
  return next;
}

const WIN_LINES: [number, number, number][] = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

export function detectWinner(board: Uint8Array): 0 | 1 | 2 | "draw" {
  for (const [a, b, c] of WIN_LINES) {
    if (board[a] !== 0 && board[a] === board[b] && board[b] === board[c]) {
      return board[a] as 1 | 2;
    }
  }
  return board.every((v) => v !== 0) ? "draw" : 0;
}

// Verify a SignedMove: hash-link, board legality, token-tree membership.
export function verifySignedMove(
  m: SignedMove,
  prev: SignedMove | null,
  moverRoot: bigint
): { ok: true } | { ok: false; reason: string } {
  // 1) hash-link
  const expectedPrev = prev ? hashSignedMove(prev) : new Uint8Array(32);
  if (!eqBytes(m.prevHash, expectedPrev)) {
    return { ok: false, reason: "hash-link mismatch (prevHash does not chain)" };
  }
  // 2) board derived from prev + (cell, mark) matches boardAfter
  const boardBefore = prev ? prev.boardAfter : new Uint8Array(9);
  const status = detectWinner(boardBefore);
  if (status !== 0) {
    return { ok: false, reason: `game already ended (${status})` };
  }
  const mark: 1 | 2 = m.turn % 2 === 0 ? 1 : 2;
  let derivedBoard: Uint8Array;
  try {
    derivedBoard = applyMove(boardBefore, m.cell, mark);
  } catch (e) {
    return { ok: false, reason: `illegal move: ${(e as Error).message}` };
  }
  if (!eqBytes(derivedBoard, m.boardAfter)) {
    return { ok: false, reason: "boardAfter does not match prev + move" };
  }
  if (prev && m.turn !== prev.turn + 1) {
    return { ok: false, reason: `turn not contiguous (prev=${prev.turn}, this=${m.turn})` };
  }
  if (!prev && m.turn !== 0) {
    return { ok: false, reason: `first move must be turn 0, got ${m.turn}` };
  }
  // 3) token membership under the mover's root
  const expectedLeaf = computeTokenLeaf(m.turn, m.cell, m.token.secret);
  if (!eqBytes(expectedLeaf, m.token.path.leaf)) {
    return { ok: false, reason: "token leaf preimage mismatch" };
  }
  const derivedRoot = merklePathRootField(m.token.path.leaf, m.token.path.path);
  if (derivedRoot !== moverRoot) {
    return { ok: false, reason: "token does not sit under the mover's root" };
  }
  return { ok: true };
}

// Equivocation = same turn, two different cells, both validly signed by the
// same player. Returns the two tokens packaged for proveEquivocationBy{X,O}.
export type EquivocationProof = {
  turn: number;
  cellA: number; secretA: Uint8Array; pathA: MerklePath;
  cellB: number; secretB: Uint8Array; pathB: MerklePath;
};

export function buildEquivocationProof(a: SignedMove, b: SignedMove): EquivocationProof {
  if (a.turn !== b.turn) throw new Error("not equivocation: turns differ");
  if (a.cell === b.cell) throw new Error("not equivocation: same cell");
  return {
    turn: a.turn,
    cellA: a.cell, secretA: a.token.secret, pathA: a.token.path,
    cellB: b.cell, secretB: b.token.secret, pathB: b.token.path,
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
