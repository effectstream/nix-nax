// Pure game rules for the 4×4 stacked-pieces game. No crypto, no I/O —
// shared by the webapp UI, off-chain move verification, and tests. The
// Compact contract implements the SAME rules in-circuit; any change here
// must be mirrored there.
//
// Board model: 16 cells (row-major 4×4), each a stack of 4 layers. A piece
// of size s always sits at layer s (0=smallest … 3=largest), so "cover"
// means occupying a higher layer. Visible piece of a cell = highest
// occupied layer.
//
// Encoding: board = Uint8Array(64), index cell*4 + layer, value mark
// (0=empty, 1=X, 2=O). reserves = Uint8Array(8), index (mark-1)*4 + size,
// value count (0..3).

export const BOARD_DIM = 4;
export const CELLS = 16;
export const SIZES = 4;          // 4 piece sizes (0=smallest … 3=largest)
export const PIECES_PER_SIZE = 3; // 3 per size ⇒ 12 pieces per player
export const MAX_TURNS = 128;
// Settle commits up to this many moves per tx. 8 keeps the settle circuit
// within the node's per-block weight budget (16 exhausted it at deploy on the
// pre-1.0 node).
export const SETTLE_CHUNK = 8;
// The contract exports one settle entry point per chunk size (settle2 /
// settle / settle11 — one generic circuit monomorphized per size). Descending;
// the chunker takes the largest while more moves remain, then the smallest
// variant that fits the tail — fewer txs for long histories, a much smaller
// (faster-proving) circuit for short tails. 11 is the LARGEST chunk the node
// accepts: the circuit must stay k=17 (settle12 crosses to k=18 and the node
// rejects the call at dispatch — 1010 Custom(168), verification weight over
// the per-tx budget; measured on node 1.0.0). MUST match the exported
// variants in NixNaxArena.compact.
export const SETTLE_VARIANTS = [11, 8, 2] as const;

// Minimum on-chain challenge / timeout windows, in the chain's block-time unit
// (seconds). Enforced in-circuit by settle (challengeUntil) and startTimeout
// (deadline) — a caller-chosen window below these is rejected, so a settler
// can't finalise before the opponent can challenge, and a waiter can't arm an
// instant forfeit. MUST match the literals in NixNaxArena.compact.
export const MIN_CHALLENGE_SECS = 600;
export const MIN_TIMEOUT_SECS = 600;
// Minimum window a roll-class challenge leaves the mover to answer
// (challengeRoll's respondBy floor).
export const MIN_RESPONSE_SECS = 600;

export const KIND_PLACE = 1;
export const KIND_REMOVE = 2;
export const KIND_PASS = 3;
export type Kind = typeof KIND_PLACE | typeof KIND_REMOVE | typeof KIND_PASS;

// ── The 4-bit joint roll ────────────────────────────────────────────────────
// Each side pre-commits 4 bits per ceremony leaf; joint bit k = XOR of the
// two sides' bit k; roll v = Σ jk·2^k is uniform on 0..15. REMOVE iff
// v < ROLL_REMOVE_THRESHOLD (3/16 = 18.75% ≈ "about 20%"), else PLACE.
export const ROLL_BITS = 4;
export const ROLL_MAX = 16;
export const ROLL_REMOVE_THRESHOLD = 3;

export function jointRollValue(bitsI: readonly number[], bitsR: readonly number[]): number {
  let v = 0;
  for (let k = 0; k < ROLL_BITS; k++) {
    v |= ((bitsI[k] ^ bitsR[k]) & 1) << k;
  }
  return v;
}

// Action class for a roll: 0 = remove/pass turn, 1 = place turn. (Kept under
// the historical name "parity" in payloads/actionLog.)
export function classOfRoll(v: number): 0 | 1 {
  return v < ROLL_REMOVE_THRESHOLD ? 0 : 1;
}

export type Mark = 1 | 2;        // 1=X (moves on even turns), 2=O
export const opp = (m: Mark): Mark => (m === 1 ? 2 : 1);
export const moverForTurn = (turn: number): Mark => (turn % 2 === 0 ? 1 : 2);

export interface Action {
  kind: Kind;
  cell: number;                  // 0..15; canonical 0 for pass
  size: number;                  // 0..3 for place; canonical 0 for remove/pass
}

// The 10 four-in-a-row lines on a 4×4 board (row-major cell indices):
// 4 full rows + 4 full columns + 2 diagonals.
export const WIN_LINES: ReadonlyArray<readonly [number, number, number, number]> = (() => {
  const lines: [number, number, number, number][] = [];
  for (let r = 0; r < 4; r++) lines.push([r * 4, r * 4 + 1, r * 4 + 2, r * 4 + 3]); // rows
  for (let c = 0; c < 4; c++) lines.push([c, c + 4, c + 8, c + 12]);                // cols
  lines.push([0, 5, 10, 15]);                                                       // ↘
  lines.push([3, 6, 9, 12]);                                                        // ↙
  return lines; // 4 + 4 + 2 = 10
})();

// ── State constructors ──────────────────────────────────────────────────────

export function emptyBoard(): Uint8Array {
  return new Uint8Array(CELLS * SIZES);
}

export function fullReserves(): Uint8Array {
  return Uint8Array.from([3, 3, 3, 3, 3, 3, 3, 3]);
}

export const reserveIndex = (mark: Mark, size: number): number => (mark - 1) * SIZES + size;

// ── Reads ───────────────────────────────────────────────────────────────────

// Visible piece of a cell: { layer (== size), mark } or null if empty.
export function topOf(board: Uint8Array, cell: number): { layer: number; mark: Mark } | null {
  for (let layer = SIZES - 1; layer >= 0; layer--) {
    const m = board[cell * SIZES + layer];
    if (m !== 0) return { layer, mark: m as Mark };
  }
  return null;
}

// Visible mark per cell (0 if empty) — the "tops" view the win check uses.
export function topsView(board: Uint8Array): Uint8Array {
  const t = new Uint8Array(CELLS);
  for (let c = 0; c < CELLS; c++) t[c] = topOf(board, c)?.mark ?? 0;
  return t;
}

// Number of pieces stacked at a cell (0..4) — for UI pips.
export function stackDepth(board: Uint8Array, cell: number): number {
  let n = 0;
  for (let layer = 0; layer < SIZES; layer++) if (board[cell * SIZES + layer] !== 0) n++;
  return n;
}

// ── Legality ────────────────────────────────────────────────────────────────

// Place size s at cell: piece in reserve, and layers s..(SIZES-1) of the cell
// empty (strictly-larger covers smaller; own or opponent's).
export function canPlace(board: Uint8Array, reserves: Uint8Array, mark: Mark, size: number, cell: number): boolean {
  if (cell < 0 || cell >= CELLS || size < 0 || size >= SIZES) return false;
  if (reserves[reserveIndex(mark, size)] === 0) return false;
  for (let layer = size; layer < SIZES; layer++) {
    if (board[cell * SIZES + layer] !== 0) return false;
  }
  return true;
}

export function anyLegalPlace(board: Uint8Array, reserves: Uint8Array, mark: Mark): boolean {
  for (let size = 0; size < SIZES; size++) {
    if (reserves[reserveIndex(mark, size)] === 0) continue;
    for (let cell = 0; cell < CELLS; cell++) {
      if (canPlace(board, reserves, mark, size, cell)) return true;
    }
  }
  return false;
}

// Remove: any visible piece can be taken — yours OR the opponent's. The piece
// goes back to its owner's reserve (see applyAction). `mark` is unused now.
export function canRemove(board: Uint8Array, _mark: Mark, cell: number): boolean {
  if (cell < 0 || cell >= CELLS) return false;
  return topOf(board, cell) !== null;
}

export function anyLegalRemove(board: Uint8Array, mark: Mark): boolean {
  for (let cell = 0; cell < CELLS; cell++) if (canRemove(board, mark, cell)) return true;
  return false;
}

// Pass exists ONLY for even-parity (remove) turns with no removable target.
// A place turn with no legal placement is a stall — handled by the timeout
// path, not by pass (rare endgame corner; see plan).
export function passIsLegal(board: Uint8Array, mark: Mark): boolean {
  return !anyLegalRemove(board, mark);
}

// Validate an action for `mark` given the turn's parity (1=odd→place,
// 0=even→remove/pass; null for turn 0 which is always a forced place).
export function validateAction(
  board: Uint8Array,
  reserves: Uint8Array,
  mark: Mark,
  parity: 0 | 1 | null,
  action: Action,
): { ok: true } | { ok: false; reason: string } {
  const { kind, cell, size } = action;
  if (parity === null) {
    // Turn 0.
    if (kind !== KIND_PLACE) return { ok: false, reason: "turn 0 must be a placement" };
  } else if (kind === KIND_PLACE) {
    if (parity !== 1) return { ok: false, reason: "place requires an odd random" };
  } else if (kind === KIND_REMOVE || kind === KIND_PASS) {
    if (parity !== 0) return { ok: false, reason: `${kind === KIND_REMOVE ? "remove" : "pass"} requires an even random` };
  } else {
    return { ok: false, reason: `unknown action kind ${kind}` };
  }

  switch (kind) {
    case KIND_PLACE:
      if (!canPlace(board, reserves, mark, size, cell)) {
        return { ok: false, reason: `illegal placement: size ${size} at cell ${cell}` };
      }
      return { ok: true };
    case KIND_REMOVE:
      if (size !== 0) return { ok: false, reason: "remove must use size=0 (canonical)" };
      if (!canRemove(board, mark, cell)) {
        return { ok: false, reason: `nothing to remove on cell ${cell}` };
      }
      return { ok: true };
    case KIND_PASS:
      if (cell !== 0 || size !== 0) return { ok: false, reason: "pass must use cell=0, size=0 (canonical)" };
      if (!passIsLegal(board, mark)) {
        return { ok: false, reason: "pass not allowed: an opponent piece is removable" };
      }
      return { ok: true };
  }
}

// ── Application ─────────────────────────────────────────────────────────────

// Apply a VALIDATED action; returns fresh arrays (inputs untouched).
export function applyAction(
  board: Uint8Array,
  reserves: Uint8Array,
  mark: Mark,
  action: Action,
): { board: Uint8Array; reserves: Uint8Array; removed?: { mark: Mark; size: number } } {
  const b = new Uint8Array(board);
  const r = new Uint8Array(reserves);
  switch (action.kind) {
    case KIND_PLACE: {
      b[action.cell * SIZES + action.size] = mark;
      r[reserveIndex(mark, action.size)] -= 1;
      return { board: b, reserves: r };
    }
    case KIND_REMOVE: {
      const top = topOf(board, action.cell);
      if (!top) throw new Error("applyAction: remove on empty cell");
      b[action.cell * SIZES + top.layer] = 0;
      // The piece goes back to its OWNER's reserve; layer == size.
      r[reserveIndex(top.mark, top.layer)] += 1;
      return { board: b, reserves: r, removed: { mark: top.mark, size: top.layer } };
    }
    case KIND_PASS:
      return { board: b, reserves: r };
  }
}

// ── Win detection ───────────────────────────────────────────────────────────

function lineWinFor(tops: Uint8Array, mark: Mark): boolean {
  for (const [a, b, c, d] of WIN_LINES) {
    if (tops[a] === mark && tops[b] === mark && tops[c] === mark && tops[d] === mark) return true;
  }
  return false;
}

// Winner after `mover` just acted. Mover's line takes precedence (a removal
// can reveal lines for either side simultaneously).
export function winnerAfterMove(board: Uint8Array, mover: Mark): Mark | 0 {
  const tops = topsView(board);
  if (lineWinFor(tops, mover)) return mover;
  if (lineWinFor(tops, opp(mover))) return opp(mover);
  return 0;
}

// ── Serialization helpers ───────────────────────────────────────────────────

export function boardEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Packed action byte used by the contract's actionLog (low 8 bits; the
// claimed parity rides at +256 in the Uint<16>). size 0..3 fits in 2 bits.
export function packAction(a: Action): number {
  return a.kind * 64 + a.size * 16 + a.cell;
}
export function unpackAction(packedLow: number): Action {
  const kind = Math.floor(packedLow / 64) as Kind;
  const size = Math.floor((packedLow % 64) / 16);
  const cell = packedLow % 16;
  return { kind, cell, size };
}
export function packLogEntry(claimedParity: 0 | 1, a: Action): number {
  return claimedParity * 256 + packAction(a);
}
export function unpackLogEntry(packed: number): { claimedParity: 0 | 1; action: Action } {
  return {
    claimedParity: packed >= 256 ? 1 : 0,
    action: unpackAction(packed % 256),
  };
}
