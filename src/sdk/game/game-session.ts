// GameSession — high-level player API.
//
// Wraps the local crypto (identity secret + token tree) and the on-chain
// callTx surface so the e2e tests and the CLI don't have to assemble
// circuit arguments by hand.
//
// Important: a "player" here is a cryptographic identity (skP + tokenTree),
// not a wallet. Anyone with the move log can submit `settle` /
// `proveEquivocation` / `claimTimeout` / `claimResult` on-chain because they
// are payload-authenticated. `startTimeout` is the only call that needs the
// player's secret as a witness — for that, the GameSession sets its private
// state to that secret before invoking.

import { TransactionId } from "@midnight-ntwrk/ledger-v8";
import {
  applyMove,
  buildEquivocationProof,
  computePlayerId,
  computeTokenLeaf,
  detectWinner,
  hashSignedMove,
  isMyTurn,
  randomBytes32,
  type SignedMove,
  verifySignedMove,
} from "../crypto/index.ts";
import { buildTokenTree, type MerklePath, type TokenTree } from "../crypto/token-tree.ts";
import { attachTicTacToe, deployTicTacToe, joinChannelCall, readLedger, type DeployArgs, type JoinArgs } from "../deploy.ts";
import {
  createTicTacToePrivateState,
} from "../../contract/witnesses.ts";

export type PlayerRole = "x" | "o";

const ZERO_BYTES_32 = new Uint8Array(32);
const ZERO_PATH: MerklePath = {
  leaf: ZERO_BYTES_32,
  path: Array.from({ length: 10 }, () => ({ sibling: { field: 0n }, goes_left: false })),
};

export interface PlayerKeys {
  role: PlayerRole;
  secret: Uint8Array;        // 32 bytes — the identity secret skP
  id: Uint8Array;            // playerId(secret)
  tokenTree: TokenTree;
}

export function generatePlayer(role: PlayerRole, rng: () => Uint8Array = randomBytes32): PlayerKeys {
  const secret = rng();
  const id = computePlayerId(secret);
  const tokenTree = buildTokenTree(rng);
  return { role, secret, id, tokenTree };
}

// Shared init: build keys for both players, deploy the channel, return the
// SessionContexts each player should use. (In real life each player would
// generate their own keys and ONLY share `id` + `root` with the opponent.)
export async function openChannelTogether(
  rng: () => Uint8Array = randomBytes32,
  seed?: string,
): Promise<{ x: GameSession; o: GameSession; contractAddress: string }> {
  const x = generatePlayer("x", rng);
  const o = generatePlayer("o", rng);

  // Phase 1: X deploys with only their commitments → channel is halfOpen.
  const args: DeployArgs = {
    idX: x.id,
    rootX: x.tokenTree.root,
  };
  const { contractAddress, wallet, providers } = await deployTicTacToe({
    args,
    seed,
    initialPrivateState: createTicTacToePrivateState(x.secret),
    privateStateStoreName: "ttt-deploy",
  });

  // Phase 2: O joins with their own commitments → channel becomes inProgress.
  const joinArgs: JoinArgs = { idO: o.id, rootO: o.tokenTree.root };
  await joinChannelCall({ contractAddress, joinArgs, wallet });

  const xSession = await GameSession.attachFor(x, contractAddress, { wallet });
  const oSession = await GameSession.attachFor(o, contractAddress, { wallet });
  void providers;
  return { x: xSession, o: oSession, contractAddress };
}

export class GameSession {
  private movesLog: SignedMove[] = [];
  private board: Uint8Array = new Uint8Array(9);
  private contractAddress: string;
  private deployed: any;
  private providers: any;
  private opponent: { id: Uint8Array; root: bigint } | null = null;

  private constructor(
    public readonly keys: PlayerKeys,
    contractAddress: string,
    deployed: any,
    providers: any,
  ) {
    this.contractAddress = contractAddress;
    this.deployed = deployed;
    this.providers = providers;
  }

  static async attachFor(
    keys: PlayerKeys,
    contractAddress: string,
    opts?: { seed?: string; wallet?: any },
  ): Promise<GameSession> {
    const { found, providers } = await attachTicTacToe({
      contractAddress,
      seed: opts?.seed,
      wallet: opts?.wallet,
      initialPrivateState: createTicTacToePrivateState(keys.secret),
      privateStateStoreName: `ttt-${keys.role}-${contractAddress.slice(2, 12)}`,
      midnightDbName: `tictactoe-${keys.role}-${contractAddress.slice(2, 12)}`,
    });
    const session = new GameSession(keys, contractAddress, found, providers);
    return session;
  }

  // Once both sessions exist, set each other's opponent (id + root) so we can
  // verify incoming SignedMoves locally.
  setOpponent(other: GameSession): void {
    this.opponent = { id: other.keys.id, root: other.keys.tokenTree.root.field };
  }

  get role(): PlayerRole { return this.keys.role; }
  get address(): string { return this.contractAddress; }
  get moves(): readonly SignedMove[] { return this.movesLog; }

  // ── Off-chain move authoring ──────────────────────────────────────────────

  myMove(cell: number): SignedMove {
    if (cell < 0 || cell > 8) throw new Error("cell out of range");
    const turn = this.movesLog.length;
    if (!isMyTurn(turn, this.keys.role)) {
      throw new Error(`not your turn (turn ${turn} belongs to ${turn % 2 === 0 ? "X" : "O"})`);
    }
    if (this.board[cell] !== 0) throw new Error(`cell ${cell} already occupied`);
    if (detectWinner(this.board) !== 0) throw new Error("game already over");

    const mark = this.keys.role === "x" ? 1 : 2;
    const boardAfter = applyMove(this.board, cell, mark);
    const prevHash = this.movesLog.length === 0 ? new Uint8Array(32) : hashSignedMove(this.movesLog[this.movesLog.length - 1]);
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

  // Receive a SignedMove from the opponent; updates local state if valid.
  receiveMove(move: SignedMove): { ok: true; status: "playing" | "ended" } | { ok: false; reason: string } {
    if (!this.opponent) return { ok: false, reason: "opponent not set" };
    const prev = this.movesLog.length ? this.movesLog[this.movesLog.length - 1] : null;
    // The opponent moves only on turns belonging to them.
    const expectedTurn = this.movesLog.length;
    if (move.turn !== expectedTurn) return { ok: false, reason: `expected turn ${expectedTurn}, got ${move.turn}` };
    if (isMyTurn(move.turn, this.keys.role)) {
      return { ok: false, reason: `turn ${move.turn} is mine, not opponent's` };
    }
    if (move.channelId !== this.contractAddress) {
      return { ok: false, reason: "channelId mismatch" };
    }
    const r = verifySignedMove(move, prev, this.opponent.root);
    if (!r.ok) return r;
    this.movesLog.push(move);
    this.board = move.boardAfter;
    return { ok: true, status: detectWinner(this.board) === 0 ? "playing" : "ended" };
  }

  // ── On-chain calls ────────────────────────────────────────────────────────

  // Bundle the current log into the Vector<9, ...> shape expected by `settle`.
  buildSettlePayload(): {
    nMoves: bigint;
    cells: bigint[];
    secrets: Uint8Array[];
    paths: MerklePath[];
  } {
    const n = this.movesLog.length;
    const cells = new Array<bigint>(9).fill(0n);
    const secrets = new Array<Uint8Array>(9).fill(ZERO_BYTES_32);
    const paths = new Array<MerklePath>(9).fill(ZERO_PATH);

    for (let i = 0; i < n; i++) {
      const m = this.movesLog[i];
      cells[i] = BigInt(m.cell);
      secrets[i] = m.token.secret;
      paths[i] = m.token.path;
    }
    return { nMoves: BigInt(n), cells, secrets, paths };
  }

  async settle(challengeWindowSec = 5): Promise<TransactionId> {
    const { nMoves, cells, secrets, paths } = this.buildSettlePayload();
    const nowSec = await nowBlockTimeSec(this.providers);
    const untilTime = BigInt(nowSec + challengeWindowSec);
    const tx = await (this.deployed as any).callTx.settle(nMoves, cells, secrets, paths, untilTime);
    return tx.public.txId;
  }

  async claimResult(): Promise<TransactionId> {
    const tx = await (this.deployed as any).callTx.claimResult();
    return tx.public.txId;
  }

  async startTimeout(graceSec: number): Promise<TransactionId> {
    const nowSec = await nowBlockTimeSec(this.providers);
    const untilTime = BigInt(nowSec + graceSec);
    const tx = await (this.deployed as any).callTx.startTimeout(untilTime);
    return tx.public.txId;
  }

  async claimTimeout(): Promise<TransactionId> {
    const tx = await (this.deployed as any).callTx.claimTimeout();
    return tx.public.txId;
  }

  async proveEquivocation(twoMoves: [SignedMove, SignedMove]): Promise<TransactionId> {
    const [a, b] = twoMoves;
    const proof = buildEquivocationProof(a, b);
    // Both moves come from the SAME player (same turn parity).
    const cheaterIsX = a.turn % 2 === 0;
    const fn = cheaterIsX ? "proveEquivocationByX" : "proveEquivocationByO";
    const tx = await (this.deployed as any).callTx[fn](
      BigInt(proof.turn),
      BigInt(proof.cellA), proof.secretA, proof.pathA,
      BigInt(proof.cellB), proof.secretB, proof.pathB,
    );
    return tx.public.txId;
  }

  async readState() {
    return readLedger(this.providers, this.contractAddress);
  }

  // ── For tests: synthesise a SignedMove for ANY (turn, cell) — used to
  // build an equivocation scenario.
  forgeMove(turn: number, cell: number, prevHash: Uint8Array, boardAfter: Uint8Array): SignedMove {
    const secret = this.keys.tokenTree.secrets[turn][cell];
    const path = this.keys.tokenTree.pathFor(turn, cell);
    return {
      channelId: this.contractAddress,
      turn, cell,
      boardAfter,
      prevHash,
      token: { secret, path },
    };
  }

  // Replace the in-memory move log (used to fork it for equivocation tests).
  resetTo(moves: SignedMove[], board: Uint8Array): void {
    this.movesLog = [...moves];
    this.board = new Uint8Array(board);
  }
}

// Current chain time in seconds since epoch. Used to seed `untilTime`
// arguments to settle / startTimeout. The compact-runtime simulator and
// the substrate Timestamp pallet both expose block time in seconds.
async function nowBlockTimeSec(_providers: any): Promise<number> {
  return Math.floor(Date.now() / 1000);
}
