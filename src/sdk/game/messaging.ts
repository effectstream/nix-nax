// JSON serialisation of SignedMove for peer-to-peer transport (stdin/stdout,
// websocket, paste). Uint8Array <-> hex; bigint <-> "0x..." string.

import type { SignedMove } from "../crypto/signed-move.ts";
import type { MerklePath, PathEntry } from "../crypto/token-tree.ts";

export type WireSignedMove = {
  channelId: string;
  turn: number;
  cell: number;
  boardAfter: string;            // hex (length 18)
  prevHash: string;              // hex (length 64)
  token: {
    secret: string;              // hex
    path: { leaf: string; path: { sibling: string; goes_left: boolean }[] };
  };
};

const toHex = (b: Uint8Array): string => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (s: string): Uint8Array => {
  const m = (s.startsWith("0x") ? s.slice(2) : s).match(/.{1,2}/g) ?? [];
  return new Uint8Array(m.map((b) => parseInt(b, 16)));
};

export function encodeMove(m: SignedMove): WireSignedMove {
  return {
    channelId: m.channelId,
    turn: m.turn,
    cell: m.cell,
    boardAfter: toHex(m.boardAfter),
    prevHash: toHex(m.prevHash),
    token: {
      secret: toHex(m.token.secret),
      path: {
        leaf: toHex(m.token.path.leaf),
        path: m.token.path.path.map((e) => ({
          sibling: "0x" + e.sibling.field.toString(16),
          goes_left: e.goes_left,
        })),
      },
    },
  };
}

export function decodeMove(w: WireSignedMove): SignedMove {
  const path: PathEntry[] = w.token.path.path.map((e) => ({
    sibling: { field: BigInt(e.sibling) },
    goes_left: e.goes_left,
  }));
  const mp: MerklePath = { leaf: fromHex(w.token.path.leaf), path };
  return {
    channelId: w.channelId,
    turn: w.turn,
    cell: w.cell,
    boardAfter: fromHex(w.boardAfter),
    prevHash: fromHex(w.prevHash),
    token: { secret: fromHex(w.token.secret), path: mp },
  };
}

export function stringifyMove(m: SignedMove): string {
  return JSON.stringify(encodeMove(m), null, 2);
}

export function parseMove(text: string): SignedMove {
  return decodeMove(JSON.parse(text));
}
