// Browser-side game session: identity + token tree + move log + verification.
// Talks to the chain ONLY via the relay's HTTP API; this class does no
// network I/O itself. The crypto module is imported as-is from the project
// SDK (it's pure functions over @midnight-ntwrk/compact-runtime).

import {
  computePlayerId,
  randomBytes32,
} from "../../../src/sdk/crypto/persistent-hash.ts";
import {
  applyMove,
  buildEquivocationProof,
  detectWinner,
  hashSignedMove,
  isMyTurn,
  verifySignedMove,
  type SignedMove,
  type EquivocationProof,
} from "../../../src/sdk/crypto/signed-move.ts";
import {
  buildTokenTree,
  type MerklePath,
  type TokenTree,
} from "../../../src/sdk/crypto/token-tree.ts";

export type Role = "x" | "o";

export interface PlayerKeys {
  role: Role;
  secret: Uint8Array;
  id: Uint8Array;
  tokenTree: TokenTree;
}

export interface OpponentInfo {
  id: Uint8Array;          // 32 bytes
  root: bigint;            // MerkleTreeDigest.field
}

export interface SerializedSession {
  role: Role;
  contractAddress: string;
  secret: string;          // hex
  // Token-tree secrets[turn][cell] — sufficient to rebuild the tree.
  treeSecrets: string[][];
  opponent: { id: string; root: string } | null;
  moves: SerializedMove[];
}
export interface SerializedMove {
  channelId: string;
  turn: number;
  cell: number;
  boardAfter: string;
  prevHash: string;
  token: {
    secret: string;
    path: { leaf: string; path: { sibling: string; goes_left: boolean }[] };
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

const hex = (b: Uint8Array): string => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (s: string): Uint8Array => {
  const m = (s.startsWith("0x") ? s.slice(2) : s).match(/.{1,2}/g) ?? [];
  return new Uint8Array(m.map((x) => parseInt(x, 16)));
};

export function generatePlayerKeys(role: Role): PlayerKeys {
  const secret = randomBytes32();
  return {
    role,
    secret,
    id: computePlayerId(secret),
    tokenTree: buildTokenTree(),
  };
}

export function rebuildKeys(role: Role, secret: Uint8Array, treeSecrets: Uint8Array[][]): PlayerKeys {
  let i = 0;
  const rng = (): Uint8Array => {
    const t = Math.floor(i / 9);
    const c = i % 9;
    if (t < 9 && c < 9) {
      const s = treeSecrets[t]?.[c];
      if (!s) throw new Error(`missing token-tree secret at [${t}][${c}]`);
      i++;
      return s;
    }
    // After the 81 player tokens the tree fills its padding with zero hashes.
    // buildTokenTree's rng is consumed exactly 81 times, so we shouldn't reach here.
    i++;
    return new Uint8Array(32);
  };
  return { role, secret, id: computePlayerId(secret), tokenTree: buildTokenTree(rng) };
}

// ── PlayerSession ──────────────────────────────────────────────────────────

const ZERO_BYTES = new Uint8Array(32);
const ZERO_PATH: MerklePath = {
  leaf: ZERO_BYTES,
  path: Array.from({ length: 10 }, () => ({ sibling: { field: 0n }, goes_left: false })),
};

export class PlayerSession {
  readonly role: Role;
  readonly contractAddress: string;
  readonly keys: PlayerKeys;
  private opponent: OpponentInfo | null;
  private movesLog: SignedMove[] = [];
  private board: Uint8Array = new Uint8Array(9);

  constructor(role: Role, contractAddress: string, keys: PlayerKeys, opponent: OpponentInfo | null = null) {
    this.role = role;
    this.contractAddress = contractAddress;
    this.keys = keys;
    this.opponent = opponent;
  }

  get opponentInfo(): OpponentInfo | null { return this.opponent; }
  get moves(): readonly SignedMove[] { return this.movesLog; }
  get boardState(): Uint8Array { return new Uint8Array(this.board); }
  get nextTurnRole(): Role { return this.movesLog.length % 2 === 0 ? "x" : "o"; }
  get committedTurns(): number { return this.movesLog.length; }
  get gameStatus(): "playing" | "ended" {
    return detectWinner(this.board) === 0 ? "playing" : "ended";
  }
  get winnerLocal(): 0 | 1 | 2 | "draw" {
    return detectWinner(this.board);
  }

  setOpponent(info: OpponentInfo): void {
    this.opponent = info;
  }

  // Produce my move for `cell`. Mutates local state (appends + updates board).
  myMove(cell: number): SignedMove {
    if (cell < 0 || cell > 8) throw new Error("cell out of range");
    const turn = this.movesLog.length;
    if (!isMyTurn(turn, this.role)) {
      throw new Error(`not your turn (turn ${turn} belongs to ${turn % 2 === 0 ? "X" : "O"})`);
    }
    if (this.board[cell] !== 0) throw new Error(`cell ${cell} already occupied`);
    if (this.gameStatus === "ended") throw new Error("game already over");

    const mark = this.role === "x" ? 1 : 2;
    const boardAfter = applyMove(this.board, cell, mark);
    const prevHash =
      this.movesLog.length === 0 ? new Uint8Array(32) : hashSignedMove(this.movesLog[this.movesLog.length - 1]);
    const secret = this.keys.tokenTree.secrets[turn][cell];
    const path = this.keys.tokenTree.pathFor(turn, cell);

    const move: SignedMove = {
      channelId: this.contractAddress,
      turn, cell,
      boardAfter,
      prevHash,
      token: { secret, path },
    };
    this.movesLog.push(move);
    this.board = boardAfter;
    return move;
  }

  // Receive a move from the opponent over the wire. Verifies and applies.
  receiveMove(m: SignedMove): { ok: true; status: "playing" | "ended" } | { ok: false; reason: string } {
    if (!this.opponent) return { ok: false, reason: "opponent not set" };
    const prev = this.movesLog.length ? this.movesLog[this.movesLog.length - 1] : null;
    const expectedTurn = this.movesLog.length;
    if (m.turn !== expectedTurn) return { ok: false, reason: `expected turn ${expectedTurn}, got ${m.turn}` };
    if (isMyTurn(m.turn, this.role)) return { ok: false, reason: `turn ${m.turn} is mine, not opponent's` };
    if (m.channelId !== this.contractAddress) return { ok: false, reason: "channelId mismatch" };
    const v = verifySignedMove(m, prev, this.opponent.root);
    if (!v.ok) return v;
    this.movesLog.push(m);
    this.board = m.boardAfter;
    return { ok: true, status: this.gameStatus };
  }

  // Build the Vector<9>-shaped payload for /api/settle.
  settlePayload(untilTimeSec: number): {
    nMoves: number;
    cells: number[];
    secrets: string[];
    paths: { leaf: string; path: { sibling: string; goes_left: boolean }[] }[];
    untilTime: string;
  } {
    const n = this.movesLog.length;
    const cells = new Array<number>(9).fill(0);
    const secrets = new Array<string>(9).fill(hex(ZERO_BYTES));
    const paths = new Array<any>(9).fill(serialisePath(ZERO_PATH));
    for (let i = 0; i < n; i++) {
      const m = this.movesLog[i];
      cells[i] = m.cell;
      secrets[i] = hex(m.token.secret);
      paths[i] = serialisePath(m.token.path);
    }
    return { nMoves: n, cells, secrets, paths, untilTime: String(untilTimeSec) };
  }

  // Detect if the *opponent* has revealed two tokens for the same turn at
  // different cells (i.e., they equivocated). Returns the proof if so.
  detectEquivocation(extraMoves: SignedMove[] = []): EquivocationProof | null {
    const opponentRole: Role = this.role === "x" ? "o" : "x";
    const opponentTurns = (m: SignedMove) => (opponentRole === "x" ? m.turn % 2 === 0 : m.turn % 2 === 1);
    const candidates = [...this.movesLog, ...extraMoves].filter(opponentTurns);
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const a = candidates[i], b = candidates[j];
        if (a.turn === b.turn && a.cell !== b.cell) {
          return buildEquivocationProof(a, b);
        }
      }
    }
    return null;
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  serialise(): SerializedSession {
    const treeSecrets: string[][] = [];
    for (let t = 0; t < 9; t++) {
      treeSecrets[t] = [];
      for (let c = 0; c < 9; c++) {
        treeSecrets[t][c] = hex(this.keys.tokenTree.secrets[t][c]);
      }
    }
    return {
      role: this.role,
      contractAddress: this.contractAddress,
      secret: hex(this.keys.secret),
      treeSecrets,
      opponent: this.opponent
        ? { id: hex(this.opponent.id), root: "0x" + this.opponent.root.toString(16) }
        : null,
      moves: this.movesLog.map(serialiseMove),
    };
  }

  static restore(s: SerializedSession): PlayerSession {
    const secret = fromHex(s.secret);
    const tree = s.treeSecrets.map((row) => row.map(fromHex));
    const keys = rebuildKeys(s.role, secret, tree);
    const session = new PlayerSession(
      s.role,
      s.contractAddress,
      keys,
      s.opponent ? { id: fromHex(s.opponent.id), root: BigInt(s.opponent.root) } : null,
    );
    for (const m of s.moves) {
      session.movesLog.push(deserialiseMove(m));
    }
    session.board = session.movesLog.length
      ? new Uint8Array(session.movesLog[session.movesLog.length - 1].boardAfter)
      : new Uint8Array(9);
    return session;
  }
}

// ── Wire codecs (also reused by api/ws.ts) ─────────────────────────────────

export function serialisePath(p: MerklePath): SerializedMove["token"]["path"] {
  return {
    leaf: hex(p.leaf),
    path: p.path.map((e) => ({ sibling: "0x" + e.sibling.field.toString(16), goes_left: e.goes_left })),
  };
}
export function deserialisePath(p: SerializedMove["token"]["path"]): MerklePath {
  return {
    leaf: fromHex(p.leaf),
    path: p.path.map((e) => ({ sibling: { field: BigInt(e.sibling) }, goes_left: e.goes_left })),
  };
}
export function serialiseMove(m: SignedMove): SerializedMove {
  return {
    channelId: m.channelId,
    turn: m.turn,
    cell: m.cell,
    boardAfter: hex(m.boardAfter),
    prevHash: hex(m.prevHash),
    token: { secret: hex(m.token.secret), path: serialisePath(m.token.path) },
  };
}
export function deserialiseMove(m: SerializedMove): SignedMove {
  return {
    channelId: m.channelId,
    turn: m.turn,
    cell: m.cell,
    boardAfter: fromHex(m.boardAfter),
    prevHash: fromHex(m.prevHash),
    token: { secret: fromHex(m.token.secret), path: deserialisePath(m.token.path) },
  };
}
