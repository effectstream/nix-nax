// JSON wire codecs for the three off-chain message types (Intent,
// RandomReveal, SignedMove). Uint8Array <-> hex; bigint <-> "0x..." string.
// Shared by the webapp (WS payloads, localStorage) and tests.

import type {
  Intent,
  RandomReveal,
  SignedMove,
  MerklePath,
} from "../crypto/signed-move.ts";
import type { Kind } from "./rules.ts";

export type WirePath = { leaf: string; path: { sibling: string; goes_left: boolean }[] };

export type WireIntent = {
  channelId: string;
  turn: number;
  slot: number;
  bits: number[];
  secret: string;
  path: WirePath;
};

export type WireRandomReveal = {
  channelId: string;
  turn: number;
  slot: number;
  bits: number[];
  random: string;
  path: WirePath;
};

export type WireSignedMove = {
  channelId: string;
  turn: number;
  kind: number;
  cell: number;
  size: number;
  boardAfter: string;        // 96 hex chars (48 bytes)
  reservesAfter: string;     // 12 hex chars (6 bytes)
  prevHash: string;
  token: { secret: string; path: WirePath };
  indexReveal: WireIntent | null;
  randomReveal: WireRandomReveal | null;
};

export const toHex = (b: Uint8Array): string =>
  Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
export const fromHex = (s: string): Uint8Array => {
  const m = (s.startsWith("0x") ? s.slice(2) : s).match(/.{1,2}/g) ?? [];
  return new Uint8Array(m.map((b) => parseInt(b, 16)));
};

export function encodePath(p: MerklePath): WirePath {
  return {
    leaf: toHex(p.leaf),
    path: p.path.map((e) => ({ sibling: "0x" + e.sibling.field.toString(16), goes_left: e.goes_left })),
  };
}
export function decodePath(w: WirePath): MerklePath {
  return {
    leaf: fromHex(w.leaf),
    path: w.path.map((e) => ({ sibling: { field: BigInt(e.sibling) }, goes_left: e.goes_left })),
  };
}

export function encodeIntent(it: Intent): WireIntent {
  return {
    channelId: it.channelId,
    turn: it.turn,
    slot: it.slot,
    bits: it.bits.slice(),
    secret: toHex(it.secret),
    path: encodePath(it.path),
  };
}
export function decodeIntent(w: WireIntent): Intent {
  return {
    channelId: w.channelId,
    turn: w.turn,
    slot: w.slot,
    bits: w.bits.slice(),
    secret: fromHex(w.secret),
    path: decodePath(w.path),
  };
}

export function encodeRandomReveal(r: RandomReveal): WireRandomReveal {
  return {
    channelId: r.channelId,
    turn: r.turn,
    slot: r.slot,
    bits: r.bits.slice(),
    random: toHex(r.random),
    path: encodePath(r.path),
  };
}
export function decodeRandomReveal(w: WireRandomReveal): RandomReveal {
  return {
    channelId: w.channelId,
    turn: w.turn,
    slot: w.slot,
    bits: w.bits.slice(),
    random: fromHex(w.random),
    path: decodePath(w.path),
  };
}

export function encodeMove(m: SignedMove): WireSignedMove {
  return {
    channelId: m.channelId,
    turn: m.turn,
    kind: m.kind,
    cell: m.cell,
    size: m.size,
    boardAfter: toHex(m.boardAfter),
    reservesAfter: toHex(m.reservesAfter),
    prevHash: toHex(m.prevHash),
    token: { secret: toHex(m.token.secret), path: encodePath(m.token.path) },
    indexReveal: m.indexReveal ? encodeIntent(m.indexReveal) : null,
    randomReveal: m.randomReveal ? encodeRandomReveal(m.randomReveal) : null,
  };
}
export function decodeMove(w: WireSignedMove): SignedMove {
  return {
    channelId: w.channelId,
    turn: w.turn,
    kind: w.kind as Kind,
    cell: w.cell,
    size: w.size,
    boardAfter: fromHex(w.boardAfter),
    reservesAfter: fromHex(w.reservesAfter),
    prevHash: fromHex(w.prevHash),
    token: { secret: fromHex(w.token.secret), path: decodePath(w.token.path) },
    indexReveal: w.indexReveal ? decodeIntent(w.indexReveal) : null,
    randomReveal: w.randomReveal ? decodeRandomReveal(w.randomReveal) : null,
  };
}

export function stringifyMove(m: SignedMove): string {
  return JSON.stringify(encodeMove(m), null, 2);
}
export function parseMove(text: string): SignedMove {
  return decodeMove(JSON.parse(text));
}
