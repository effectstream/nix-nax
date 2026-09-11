// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

// Browser-side game session for the 4×4 stacked-pieces game: identity +
// three Merkle trees (T/I/R) + the per-turn ceremony state machine + move
// log + verification. This class does no network I/O; the UI sends ceremony
// messages through a relay and submits contract calls through the chain module.
//
// Per-turn flow (turn >= 1):
//   my turn:    myIntent() -> [opponent's RandomReveal arrives] -> myMove()
//   their turn: receiveIntent() -> respondWithRandom() -> receiveMove()

import {
  computePlayerId,
  randomBytes32,
} from "../../../src/sdk/crypto/persistent-hash.ts";
import {
  buildTokenTree,
  secretFor,
  ACTIONS_PER_TURN,
  type TokenTree,
} from "../../../src/sdk/crypto/token-tree.ts";
import {
  buildIndexTree,
  SLOTS_PER_TURN,
  type IndexTree,
} from "../../../src/sdk/crypto/index-tree.ts";
import {
  buildRandomTree,
  type RandomTree,
} from "../../../src/sdk/crypto/random-tree.ts";
import {
  hashSignedMove,
  verifyIntent,
  verifyRandomReveal,
  verifySignedMove,
  type Intent,
  type RandomReveal,
  type SignedMove,
} from "../../../src/sdk/crypto/signed-move.ts";
import {
  MAX_TURNS,
  SETTLE_CHUNK,
  KIND_PLACE,
  applyAction,
  anyLegalPlace,
  anyLegalRemove,
  classOfRoll,
  emptyBoard,
  fullReserves,
  jointRollValue,
  moverForTurn,
  topsView,
  winnerAfterMove,
  type Action,
  type Kind,
  type Mark,
} from "../../../src/sdk/game/rules.ts";
import {
  encodeIntent,
  decodeIntent,
  encodeRandomReveal,
  decodeRandomReveal,
  encodeMove,
  decodeMove,
  encodePath,
  toHex,
  fromHex,
  type WireIntent,
  type WireRandomReveal,
  type WireSignedMove,
  type WirePath,
} from "../../../src/sdk/game/messaging.ts";

export type Role = "x" | "o";
export { SLOTS_PER_TURN };
export {
  encodeIntent, decodeIntent, encodeRandomReveal, decodeRandomReveal,
  encodeMove, decodeMove,
};
export type { WireIntent, WireRandomReveal, WireSignedMove, Intent, RandomReveal, SignedMove };

export interface PlayerKeys {
  role: Role;
  secret: Uint8Array;
  id: Uint8Array;
  tokenTree: TokenTree;
  indexTree: IndexTree;
  randomTree: RandomTree;
}

// SIMPLIFIED (teaching) version: only the TOKEN root is committed on-chain, so
// moves are verified under the opponent's root but the roll-ceremony reveals
// (I/R trees) are integrity-checked without root membership — this version
// trusts the players on the dice.
export interface OpponentInfo {
  id: Uint8Array;
  rootToken: bigint;
}

export type TurnPhase =
  | { phase: "gameOver"; winner: Mark | "draw" }
  | { phase: "myIntent" }                    // my turn; intent not yet sent
  | { phase: "awaitRandom" }                 // my turn; waiting for the reveal
  | { phase: "act"; parity: 0 | 1 | null }   // my turn; ready (null = turn 0)
  | { phase: "waitOpponent" };               // their turn

export interface TurnRecord {
  turn: number;
  mover: Role;
  action: Action | null;          // null while the turn is still pending
  slot: number | null;
  roll: number | null;            // joint 4-bit roll value (0..15)
  parity: 0 | 1 | null;           // action class: 1=place, 0=remove/pass
  random: Uint8Array | null;      // the responder's revealed 32 bytes
}

// ── Key generation / rebuild ────────────────────────────────────────────────

export function generatePlayerKeys(role: Role, gameId: Uint8Array): PlayerKeys {
  const secret = randomBytes32();
  return {
    role,
    secret,
    id: computePlayerId(gameId, secret),
    tokenTree: buildTokenTree(gameId),
    indexTree: buildIndexTree(gameId),
    randomTree: buildRandomTree(gameId),
  };
}

// Rebuild all three trees from serialized secrets (deterministic replay of
// the builders' rng consumption order).
export function rebuildKeys(
  role: Role,
  gameId: Uint8Array,
  secret: Uint8Array,
  tokenSecrets: Uint8Array,   // 8320 × 32 bytes, turn-major offset order
  indexSecrets: Uint8Array,   // 128 × 32
  indexSlots: number[],       // 128
  indexBits: number[],        // 128 × 4, flattened turn-major
  randomValues: Uint8Array,   // 2048 × 32, turn-major slot order
  randomBits: number[],       // 2048 × 4, flattened leaf-major
): PlayerKeys {
  let ti = 0;
  const tokenTree = buildTokenTree(gameId, () => tokenSecrets.subarray(ti * 32, ++ti * 32));
  let ii = 0, is = 0, ib = 0;
  const indexTree = buildIndexTree(
    gameId,
    () => indexSecrets.subarray(ii * 32, ++ii * 32),
    () => indexSlots[is++],
    () => indexBits[ib++],
  );
  let ri = 0, rb = 0;
  const randomTree = buildRandomTree(
    gameId,
    () => randomValues.subarray(ri * 32, ++ri * 32),
    () => randomBits[rb++],
  );
  return { role, secret, id: computePlayerId(gameId, secret), tokenTree, indexTree, randomTree };
}

// ── Serialized session ──────────────────────────────────────────────────────

export interface SerializedSession {
  v: 3;
  role: Role;
  gameId: string;            // hex, 32 bytes — also the channelId
  secret: string;
  tokenSecrets: string;       // hex blob
  indexSecrets: string;       // hex blob
  indexSlots: number[];
  indexBits: number[];
  randomValues: string;       // hex blob
  randomBits: number[];
  opponent: { id: string; rootToken: string } | null;
  moves: WireSignedMove[];
  intents: (WireIntent | null)[];        // by turn
  reveals: (WireRandomReveal | null)[];  // by turn
  extraIntents: WireIntent[];            // opponent forks (equivocation evidence)
  extraReveals: WireRandomReveal[];
}

// ── PlayerSession ───────────────────────────────────────────────────────────

export class PlayerSession {
  readonly role: Role;
  readonly gameId: string;          // hex — doubles as the message channelId
  readonly gameIdBytes: Uint8Array;
  readonly keys: PlayerKeys;
  private opponent: OpponentInfo | null;
  private movesLog: SignedMove[] = [];
  // Ceremony per turn: intents[t] = the mover's I-reveal (mine if my turn,
  // theirs if received); reveals[t] = the responder's R-reveal.
  private intents: (Intent | null)[] = [];
  private reveals: (RandomReveal | null)[] = [];
  // Conflicting duplicates received from the opponent — fraud evidence.
  private extraIntents: Intent[] = [];
  private extraReveals: RandomReveal[] = [];
  private board: Uint8Array = emptyBoard();
  private reserves: Uint8Array = fullReserves();

  constructor(role: Role, gameId: string, keys: PlayerKeys, opponent: OpponentInfo | null = null) {
    this.role = role;
    this.gameId = gameId;
    this.gameIdBytes = fromHex(gameId);
    this.keys = keys;
    this.opponent = opponent;
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  get opponentInfo(): OpponentInfo | null { return this.opponent; }
  get moves(): readonly SignedMove[] { return this.movesLog; }
  get boardState(): Uint8Array { return new Uint8Array(this.board); }
  get reserveState(): Uint8Array { return new Uint8Array(this.reserves); }
  get committedTurns(): number { return this.movesLog.length; }
  get currentTurn(): number { return this.movesLog.length; }
  get nextTurnRole(): Role { return this.currentTurn % 2 === 0 ? "x" : "o"; }
  get myMark(): Mark { return this.role === "x" ? 1 : 2; }

  get winnerLocal(): Mark | "draw" | 0 {
    if (this.movesLog.length === 0) return 0;
    const last = this.movesLog[this.movesLog.length - 1];
    const w = winnerAfterMove(last.boardAfter, moverForTurn(last.turn));
    if (w !== 0) return w;
    return this.movesLog.length >= MAX_TURNS ? "draw" : 0;
  }
  get gameStatus(): "playing" | "ended" {
    return this.winnerLocal === 0 ? "playing" : "ended";
  }

  // What stage is the pending turn in?
  get turnPhase(): TurnPhase {
    const w = this.winnerLocal;
    if (w !== 0) return { phase: "gameOver", winner: w };
    const t = this.currentTurn;
    const myTurn = this.nextTurnRole === this.role;
    if (!myTurn) return { phase: "waitOpponent" };
    if (t === 0) return { phase: "act", parity: null };
    if (!this.intents[t]) return { phase: "myIntent" };
    if (!this.reveals[t]) return { phase: "awaitRandom" };
    return { phase: "act", parity: this.parityForTurn(t) };
  }

  // Joint 4-bit roll of turn t, if both sides' bits are known locally.
  rollForTurn(t: number): number | null {
    if (t === 0) return null;
    const it = this.intents[t];
    const rv = this.reveals[t];
    if (!it || !rv) return null;
    return jointRollValue(it.bits, rv.bits);
  }

  // Action class of turn t (1=place, 0=remove/pass) — kept under the
  // historical "parity" name used across the UI.
  parityForTurn(t: number): 0 | 1 | null {
    const v = this.rollForTurn(t);
    return v === null ? null : classOfRoll(v);
  }

  // Per-turn ceremony + action history for the UI.
  turnRecords(): TurnRecord[] {
    const n = Math.max(this.movesLog.length, this.intents.length, this.reveals.length);
    const out: TurnRecord[] = [];
    for (let t = 0; t < n; t++) {
      const m = this.movesLog[t];
      out.push({
        turn: t,
        mover: t % 2 === 0 ? "x" : "o",
        action: m ? { kind: m.kind, cell: m.cell, size: m.size } : null,
        slot: this.intents[t]?.slot ?? null,
        roll: this.rollForTurn(t),
        parity: this.parityForTurn(t),
        random: this.reveals[t]?.random ?? null,
      });
    }
    return out;
  }

  // Can the pending actor act at all? (A stuck place-turn stalls — the
  // opponent resolves it via timeout.)
  pendingActionAvailable(): boolean {
    const t = this.currentTurn;
    const mark = moverForTurn(t);
    const parity = t === 0 ? 1 : this.parityForTurn(t);
    if (parity === null) return true;
    if (parity === 1) return anyLegalPlace(this.board, this.reserves, mark);
    return true; // even: remove if available, else pass — always actionable
  }

  setOpponent(info: OpponentInfo): void {
    this.opponent = info;
  }

  // ── Ceremony: my turn ────────────────────────────────────────────────────

  // Step 1 (my turn, t >= 1): reveal my I-leaf.
  myIntent(): Intent {
    const t = this.currentTurn;
    if (this.nextTurnRole !== this.role) throw new Error("not your turn");
    if (t === 0) throw new Error("turn 0 has no ceremony");
    const existing = this.intents[t];
    if (existing) return existing;
    const it: Intent = {
      channelId: this.gameId,
      turn: t,
      slot: this.keys.indexTree.slots[t],
      bits: this.keys.indexTree.bits[t].slice(),
      secret: this.keys.indexTree.secrets[t],
      path: this.keys.indexTree.pathFor(t),
    };
    this.intents[t] = it;
    return it;
  }

  // Step 2 (my turn): the opponent's R-reveal arrives.
  receiveRandomReveal(r: RandomReveal): { ok: true } | { ok: false; reason: string } {
    if (!this.opponent) return { ok: false, reason: "opponent not set" };
    const t = r.turn;
    if (t !== this.currentTurn || this.nextTurnRole !== this.role) {
      return { ok: false, reason: `unexpected random reveal for turn ${t}` };
    }
    const it = this.intents[t];
    if (!it) return { ok: false, reason: "no intent sent for this turn yet" };
    const v = verifyRandomReveal(r, this.gameId, t, it.slot, null);
    if (!v.ok) return v;
    const prior = this.reveals[t];
    if (prior) {
      if (prior.bits.join("") !== r.bits.join("") || !bytesEq(prior.random, r.random)) {
        this.extraReveals.push(r); // equivocation evidence
        return { ok: false, reason: "conflicting random reveal recorded (fraud evidence)" };
      }
      return { ok: true };
    }
    this.reveals[t] = r;
    return { ok: true };
  }

  // Step 3 (my turn): act. Turn 0 skips the ceremony.
  myMove(action: Action): SignedMove {
    const t = this.currentTurn;
    if (this.nextTurnRole !== this.role) throw new Error("not your turn");
    if (this.gameStatus === "ended") throw new Error("game already over");
    if (t >= MAX_TURNS) throw new Error("turn cap reached");

    const move: SignedMove = {
      channelId: this.gameId,
      turn: t,
      kind: action.kind,
      cell: action.cell,
      size: action.size,
      boardAfter: emptyBoard(),    // filled below
      reservesAfter: fullReserves(),
      prevHash: this.movesLog.length
        ? hashSignedMove(this.movesLog[this.movesLog.length - 1])
        : new Uint8Array(32),
      token: {
        secret: secretFor(this.keys.tokenTree, t, action.kind, action.cell, action.size),
        path: this.keys.tokenTree.pathFor(t, action.kind, action.cell, action.size),
      },
      indexReveal: t === 0 ? null : this.intents[t],
      randomReveal: t === 0 ? null : this.reveals[t],
    };
    if (t > 0 && (!move.indexReveal || !move.randomReveal)) {
      throw new Error("ceremony incomplete: intent or random reveal missing");
    }
    const applied = applyAction(this.board, this.reserves, this.myMark, action);
    move.boardAfter = applied.board;
    move.reservesAfter = applied.reserves;

    // Self-verify before sending — catches illegal actions in one place.
    const v = verifySignedMove(move, this.movesLog[this.movesLog.length - 1] ?? null, {
      moverRootToken: this.keys.tokenTree.root.field,
      moverRootIdx: this.keys.indexTree.root.field,
      responderRootRnd: null, // opponent's root is not known in the trusting version
    });
    if (!v.ok) throw new Error(v.reason);

    this.movesLog.push(move);
    this.board = move.boardAfter;
    this.reserves = move.reservesAfter;
    return move;
  }

  // ── Ceremony: their turn ─────────────────────────────────────────────────

  // Their step 1: their intent arrives.
  receiveIntent(it: Intent): { ok: true } | { ok: false; reason: string } {
    if (!this.opponent) return { ok: false, reason: "opponent not set" };
    const t = it.turn;
    if (t !== this.currentTurn || this.nextTurnRole === this.role) {
      return { ok: false, reason: `unexpected intent for turn ${t}` };
    }
    const v = verifyIntent(it, this.gameId, t, null);
    if (!v.ok) return v;
    const prior = this.intents[t];
    if (prior) {
      if (prior.slot !== it.slot || prior.bits.join("") !== it.bits.join("")) {
        this.extraIntents.push(it); // equivocation evidence
        return { ok: false, reason: "conflicting intent recorded (fraud evidence)" };
      }
      return { ok: true };
    }
    this.intents[t] = it;
    return { ok: true };
  }

  // Their step 2: my R-reveal for their announced slot.
  respondWithRandom(): RandomReveal {
    const t = this.currentTurn;
    if (this.nextTurnRole === this.role) throw new Error("it is my turn — nothing to respond to");
    const it = this.intents[t];
    if (!it) throw new Error("no opponent intent for this turn");
    const existing = this.reveals[t];
    if (existing) return existing;
    const r: RandomReveal = {
      channelId: this.gameId,
      turn: t,
      slot: it.slot,
      bits: this.keys.randomTree.bits[t][it.slot].slice(),
      random: this.keys.randomTree.randoms[t][it.slot],
      path: this.keys.randomTree.pathFor(t, it.slot),
    };
    this.reveals[t] = r;
    return r;
  }

  // Their step 3: their move arrives.
  receiveMove(m: SignedMove): { ok: true; status: "playing" | "ended"; duplicate?: boolean } | { ok: false; reason: string } {
    if (!this.opponent) return { ok: false, reason: "opponent not set" };
    const t = m.turn;
    if (t < this.currentTurn) {
      const prior = this.movesLog[t];
      if (prior && bytesEq(hashSignedMove(prior), hashSignedMove(m))) {
        return { ok: true, status: this.gameStatus, duplicate: true };
      }
      return { ok: false, reason: `conflicting historical move for turn ${t}` };
    }
    if (t !== this.currentTurn) return { ok: false, reason: `expected turn ${this.currentTurn}, got ${t}` };
    if (this.nextTurnRole === this.role) return { ok: false, reason: `turn ${t} is mine, not the opponent's` };
    if (m.channelId !== this.gameId) return { ok: false, reason: "channelId mismatch" };

    const prev = this.movesLog.length ? this.movesLog[this.movesLog.length - 1] : null;
    const v = verifySignedMove(m, prev, {
      moverRootToken: this.opponent.rootToken,
      moverRootIdx: null,     // I/R roots are not on-chain in the trusting version
      responderRootRnd: this.keys.randomTree.root.field, // I am the responder
    });
    if (!v.ok) return v;

    // The embedded ceremony must match what was exchanged live (a different
    // embedded intent would itself be I-equivocation evidence).
    if (t > 0) {
      const known = this.intents[t];
      if (known && m.indexReveal && (known.slot !== m.indexReveal.slot || known.bits.join("") !== m.indexReveal.bits.join(""))) {
        this.extraIntents.push(m.indexReveal);
        return { ok: false, reason: "move embeds a conflicting intent (fraud evidence)" };
      }
      if (!known && m.indexReveal) this.intents[t] = m.indexReveal;
      if (!this.reveals[t] && m.randomReveal) this.reveals[t] = m.randomReveal;
    }

    this.movesLog.push(m);
    this.board = m.boardAfter;
    this.reserves = m.reservesAfter;
    return { ok: true, status: this.gameStatus };
  }

  // ── Settlement payloads ──────────────────────────────────────────────────

  // Chunked settle payloads covering local turns [fromTurn, committedTurns).
  // POST each in order; every chunk strictly extends the chain. Each chunk
  // carries up to SETTLE_CHUNK moves (unused slots zero-padded), each with its
  // one-time token reveal (secret + Merkle path) — the contract verifies them
  // under the mover's committed root.
  //
  // NO 1-MOVE CHUNKS: the node's fee layer rejects a settle tx whose state
  // transcript is minimal (Malformed(FeeCalculation) — see README "Known
  // issues"). When the tail would be 1 move, rebalance the last two chunks
  // (…7+2 instead of 8+1). A totally-single-move settle (only 1 new move
  // exists) cannot be avoided client-side.
  settleChunkPayloads(fromTurn: number): Array<{
    nMoves: number;
    kinds: number[];
    cells: number[];
    sizes: number[];
    secrets: string[];
    paths: WirePath[];
  }> {
    const zeroPath: WirePath = {
      leaf: toHex(new Uint8Array(32)),
      path: Array.from({ length: 14 }, () => ({ sibling: "0x0", goes_left: false })),
    };
    const total = this.movesLog.length - fromTurn;
    const takes: number[] = [];
    for (let remaining = total; remaining > 0; ) {
      let take = Math.min(SETTLE_CHUNK, remaining);
      if (remaining - take === 1) take -= 1; // leave a 2-move tail, never 1
      takes.push(take);
      remaining -= take;
    }
    const out = [] as ReturnType<PlayerSession["settleChunkPayloads"]>;
    let base = fromTurn;
    for (const take of takes) {
      const moves = this.movesLog.slice(base, base + take);
      const kinds = new Array<number>(SETTLE_CHUNK).fill(0);
      const cells = new Array<number>(SETTLE_CHUNK).fill(0);
      const sizes = new Array<number>(SETTLE_CHUNK).fill(0);
      const secrets = new Array<string>(SETTLE_CHUNK).fill(toHex(new Uint8Array(32)));
      const paths = new Array<WirePath>(SETTLE_CHUNK).fill(zeroPath);
      moves.forEach((m, i) => {
        kinds[i] = m.kind;
        cells[i] = m.cell;
        sizes[i] = m.size;
        secrets[i] = toHex(m.token.secret);
        paths[i] = encodePath(m.token.path);
      });
      out.push({ nMoves: moves.length, kinds, cells, sizes, secrets, paths });
      base += take;
    }
    return out;
  }

  // ── Convenience for the UI ───────────────────────────────────────────────

  legalPlacementExists(): boolean {
    return anyLegalPlace(this.board, this.reserves, this.myMark);
  }
  legalRemovalExists(): boolean {
    return anyLegalRemove(this.board, this.myMark);
  }
  topsViewNow(): Uint8Array {
    return topsView(this.board);
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  serialise(): SerializedSession {
    const tk = this.keys.tokenTree;
    const flatTokens = new Uint8Array(MAX_TURNS * ACTIONS_PER_TURN * 32);
    for (let t = 0; t < MAX_TURNS; t++) {
      for (let off = 0; off < ACTIONS_PER_TURN; off++) {
        flatTokens.set(tk.secrets[t][off], (t * ACTIONS_PER_TURN + off) * 32);
      }
    }
    const ix = this.keys.indexTree;
    const flatIdxSecrets = new Uint8Array(MAX_TURNS * 32);
    for (let t = 0; t < MAX_TURNS; t++) flatIdxSecrets.set(ix.secrets[t], t * 32);
    const rd = this.keys.randomTree;
    const flatRandoms = new Uint8Array(MAX_TURNS * SLOTS_PER_TURN * 32);
    const randomBits: number[] = [];
    for (let t = 0; t < MAX_TURNS; t++) {
      for (let s = 0; s < SLOTS_PER_TURN; s++) {
        flatRandoms.set(rd.randoms[t][s], (t * SLOTS_PER_TURN + s) * 32);
        randomBits.push(...rd.bits[t][s]);
      }
    }
    return {
      v: 3,
      role: this.role,
      gameId: this.gameId,
      secret: toHex(this.keys.secret),
      tokenSecrets: toHex(flatTokens),
      indexSecrets: toHex(flatIdxSecrets),
      indexSlots: ix.slots.slice(),
      indexBits: ix.bits.flat(),
      randomValues: toHex(flatRandoms),
      randomBits,
      opponent: this.opponent
        ? { id: toHex(this.opponent.id), rootToken: "0x" + this.opponent.rootToken.toString(16) }
        : null,
      moves: this.movesLog.map(encodeMove),
      intents: this.intents.map((x) => (x ? encodeIntent(x) : null)),
      reveals: this.reveals.map((x) => (x ? encodeRandomReveal(x) : null)),
      extraIntents: this.extraIntents.map(encodeIntent),
      extraReveals: this.extraReveals.map(encodeRandomReveal),
    };
  }

  static restore(s: SerializedSession): PlayerSession {
    if (s.v !== 3) throw new Error("incompatible session version (expected v3)");
    const keys = rebuildKeys(
      s.role,
      fromHex(s.gameId),
      fromHex(s.secret),
      fromHex(s.tokenSecrets),
      fromHex(s.indexSecrets),
      s.indexSlots,
      s.indexBits,
      fromHex(s.randomValues),
      s.randomBits,
    );
    const session = new PlayerSession(
      s.role,
      s.gameId,
      keys,
      s.opponent
        ? { id: fromHex(s.opponent.id), rootToken: BigInt(s.opponent.rootToken) }
        : null,
    );
    for (const m of s.moves) session.movesLog.push(decodeMove(m));
    session.intents = s.intents.map((x) => (x ? decodeIntent(x) : null));
    session.reveals = s.reveals.map((x) => (x ? decodeRandomReveal(x) : null));
    session.extraIntents = (s.extraIntents ?? []).map(decodeIntent);
    session.extraReveals = (s.extraReveals ?? []).map(decodeRandomReveal);
    if (session.movesLog.length) {
      const last = session.movesLog[session.movesLog.length - 1];
      session.board = new Uint8Array(last.boardAfter);
      session.reserves = new Uint8Array(last.reservesAfter);
    }
    return session;
  }
}

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
