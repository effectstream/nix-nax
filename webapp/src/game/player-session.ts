// Browser-side game session for the 4×4 stacked-pieces game: identity +
// three Merkle trees (T/I/R) + the per-turn ceremony state machine + move
// log + verification. Talks to the chain ONLY via the relay's HTTP API;
// this class does no network I/O itself.
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
  buildEquivocationProof,
  buildIndexEquivocationProof,
  buildRandomEquivocationProof,
  buildWrongParityProof,
  type Intent,
  type RandomReveal,
  type SignedMove,
  type EquivocationProof,
  type IndexEquivocationProof,
  type RandomEquivocationProof,
  type WrongParityProof,
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
  unpackLogEntry,
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

export interface OpponentInfo {
  id: Uint8Array;
  rootToken: bigint;
  rootIdx: bigint;
  rootRnd: bigint;
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
  opponent: { id: string; rootToken: string; rootIdx: string; rootRnd: string } | null;
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
    const v = verifyRandomReveal(r, this.gameId, t, it.slot, this.opponent.rootRnd);
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
      responderRootRnd: this.opponent?.rootRnd ?? 0n,
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
    const v = verifyIntent(it, this.gameId, t, this.opponent.rootIdx);
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
  receiveMove(m: SignedMove): { ok: true; status: "playing" | "ended" } | { ok: false; reason: string } {
    if (!this.opponent) return { ok: false, reason: "opponent not set" };
    const t = m.turn;
    if (t !== this.currentTurn) return { ok: false, reason: `expected turn ${this.currentTurn}, got ${t}` };
    if (this.nextTurnRole === this.role) return { ok: false, reason: `turn ${t} is mine, not the opponent's` };
    if (m.channelId !== this.gameId) return { ok: false, reason: "channelId mismatch" };

    const prev = this.movesLog.length ? this.movesLog[this.movesLog.length - 1] : null;
    const v = verifySignedMove(m, prev, {
      moverRootToken: this.opponent.rootToken,
      moverRootIdx: this.opponent.rootIdx,
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
  // POST each in order; every chunk strictly extends the chain.
  settleChunkPayloads(fromTurn: number, untilTimeSec: number): Array<{
    nMoves: number;
    parities: number[];
    kinds: number[];
    cells: number[];
    sizes: number[];
    secrets: string[];
    paths: WirePath[];
    untilTime: string;
  }> {
    const out = [] as ReturnType<PlayerSession["settleChunkPayloads"]>;
    const zeroPath: WirePath = {
      leaf: toHex(new Uint8Array(32)),
      path: Array.from({ length: 14 }, () => ({ sibling: "0x0", goes_left: false })),
    };
    for (let base = fromTurn; base < this.movesLog.length; base += SETTLE_CHUNK) {
      const moves = this.movesLog.slice(base, base + SETTLE_CHUNK);
      const parities = new Array<number>(SETTLE_CHUNK).fill(0);
      const kinds = new Array<number>(SETTLE_CHUNK).fill(0);
      const cells = new Array<number>(SETTLE_CHUNK).fill(0);
      const sizes = new Array<number>(SETTLE_CHUNK).fill(0);
      const secrets = new Array<string>(SETTLE_CHUNK).fill(toHex(new Uint8Array(32)));
      const paths = new Array<WirePath>(SETTLE_CHUNK).fill(zeroPath);
      moves.forEach((m, i) => {
        parities[i] = m.turn === 0 ? 1 : this.parityForTurn(m.turn) ?? 0;
        kinds[i] = m.kind;
        cells[i] = m.cell;
        sizes[i] = m.size;
        secrets[i] = toHex(m.token.secret);
        paths[i] = encodePath(m.token.path);
      });
      out.push({
        nMoves: moves.length,
        parities, kinds, cells, sizes, secrets, paths,
        untilTime: String(untilTimeSec),
      });
    }
    return out;
  }

  // ── Fraud detectors ──────────────────────────────────────────────────────

  // T-tree: opponent committed two actions for one turn.
  detectEquivocation(extraMoves: SignedMove[] = []): EquivocationProof | null {
    const oppTurn = (t: number) => (this.role === "x" ? t % 2 === 1 : t % 2 === 0);
    const cands = [...this.movesLog, ...extraMoves].filter((m) => oppTurn(m.turn));
    for (let i = 0; i < cands.length; i++) {
      for (let j = i + 1; j < cands.length; j++) {
        const a = cands[i], b = cands[j];
        if (a.turn === b.turn && (a.kind !== b.kind || a.cell !== b.cell || a.size !== b.size)) {
          return buildEquivocationProof(a, b);
        }
      }
    }
    return null;
  }

  // I-tree: opponent committed two (slot, bit) for one turn.
  detectIndexEquivocation(): IndexEquivocationProof | null {
    const oppTurn = (t: number) => (this.role === "x" ? t % 2 === 1 : t % 2 === 0);
    const all: Intent[] = [
      ...this.intents.filter((x): x is Intent => !!x && oppTurn(x.turn)),
      ...this.extraIntents,
    ];
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i], b = all[j];
        if (a.turn === b.turn && (a.slot !== b.slot || a.bits.join("") !== b.bits.join(""))) {
          return buildIndexEquivocationProof(a, b);
        }
      }
    }
    return null;
  }

  // R-tree: opponent committed two (bit, random) for one (turn, slot).
  detectRandomEquivocation(): RandomEquivocationProof | null {
    const oppRevealed = (t: number) => (this.role === "x" ? t % 2 === 0 : t % 2 === 1); // responder = non-mover
    const all: RandomReveal[] = [
      ...this.reveals.filter((x): x is RandomReveal => !!x && oppRevealed(x.turn)),
      ...this.extraReveals,
    ];
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i], b = all[j];
        if (a.turn === b.turn && a.slot === b.slot && (a.bits.join("") !== b.bits.join("") || !bytesEq(a.random, b.random))) {
          return buildRandomEquivocationProof(a, b);
        }
      }
    }
    return null;
  }

  // A committed OPPONENT turn whose ceremony this session never saw — the
  // unilateral-settle case the roll-class dispute (challengeRoll) exists for.
  // detectWrongParity can't act there (no local evidence to judge with); this
  // returns the first such turn so the UI can demand the evidence on-chain.
  detectUnseenRoll(chainActionLog: { turn: number; packed: number }[]): number | null {
    for (const entry of chainActionLog) {
      const t = entry.turn;
      if (t === 0) continue;
      const moverMark = t % 2 === 0 ? 1 : 2;
      if (moverMark === this.myMark) continue; // only the responder may challenge
      if (this.parityForTurn(t) === null) return t;
    }
    return null;
  }

  // Evidence for answering a roll-class challenge on MY turn t: my I-reveal +
  // the opponent's R-reveal (same payload shape as a wrong-parity proof).
  // Null if this session never completed the ceremony for t — in which case
  // the challenge is unanswerable by construction.
  rollAnswerFor(t: number): WrongParityProof | null {
    const it = this.intents[t];
    const rv = this.reveals[t];
    if (!it || !rv) return null;
    return buildWrongParityProof(it, rv);
  }

  // Wrong parity: compare the on-chain actionLog's claimed parities against
  // the locally known committed bits. Returns the first provable lie.
  detectWrongParity(chainActionLog: { turn: number; packed: number }[]): WrongParityProof | null {
    for (const entry of chainActionLog) {
      const t = entry.turn;
      if (t === 0) continue;
      const real = this.parityForTurn(t);
      if (real === null) continue; // ceremony unknown locally — cannot judge
      const { claimedParity } = unpackLogEntry(entry.packed);
      if (claimedParity === real) continue;
      const it = this.intents[t];
      const rv = this.reveals[t];
      if (!it || !rv) continue;
      return buildWrongParityProof(it, rv);
    }
    return null;
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
        ? {
            id: toHex(this.opponent.id),
            rootToken: "0x" + this.opponent.rootToken.toString(16),
            rootIdx: "0x" + this.opponent.rootIdx.toString(16),
            rootRnd: "0x" + this.opponent.rootRnd.toString(16),
          }
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
        ? {
            id: fromHex(s.opponent.id),
            rootToken: BigInt(s.opponent.rootToken),
            rootIdx: BigInt(s.opponent.rootIdx),
            rootRnd: BigInt(s.opponent.rootRnd),
          }
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
