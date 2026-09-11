// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

// Thin TS wrappers around `@midnight-ntwrk/compact-runtime` hashing primitives.
//
// Everything here mirrors the IN-CIRCUIT algorithm of NixNaxArena.compact
// and the standard library's `merkleTreePathRoot`. The tree modules compose
// these to build / verify the three per-player commitment trees:
//   T-tree — one-time action tokens (turn, kind, cell, size)
//   I-tree — per-turn slot pick + parity bit of the mover
//   R-tree — per-(turn, slot) random + parity bit of the responder
//
// Hashing parity is the single most important correctness property — if a
// byte differs between in-circuit and in-TS hashing, every settle / fraud
// proof / verifySignedMove fails. The crypto test feeds a TS-built path back
// through the contract simulator to assert byte-for-byte parity.

import {
  CompactTypeBytes,
  CompactTypeField,
  CompactTypeUnsignedInteger,
  CompactTypeVector,
  type CompactType,
  persistentHash,
  transientHash,
  degradeToTransient,
} from "@midnight-ntwrk/compact-runtime";

// ── Primitive descriptors ──────────────────────────────────────────────────

export const Bytes6Descriptor = new CompactTypeBytes(6);
export const Bytes32Descriptor = new CompactTypeBytes(32);
export const Uint8Descriptor = new CompactTypeUnsignedInteger(255n, 1);
export const Uint16Descriptor = new CompactTypeUnsignedInteger(65535n, 2);
export const FieldDescriptor = CompactTypeField;

export const Vector2Bytes32Descriptor = new CompactTypeVector(2, Bytes32Descriptor);
export const Vector3Bytes32Descriptor = new CompactTypeVector(3, Bytes32Descriptor);
export const Vector2FieldDescriptor = new CompactTypeVector(2, FieldDescriptor);

// ── Compact's std-lib `LeafPreimage<Bytes<32>>` (for merkleTreePathRoot) ───
// struct LeafPreimage<T> { domain_sep: Bytes<6>, data: T }

export type LeafPreimage32 = { domain_sep: Uint8Array; data: Uint8Array };
export const LeafPreimage32Descriptor: CompactType<LeafPreimage32> = {
  alignment: () => Bytes6Descriptor.alignment().concat(Bytes32Descriptor.alignment()),
  fromValue(v) {
    return {
      domain_sep: Bytes6Descriptor.fromValue(v),
      data: Bytes32Descriptor.fromValue(v),
    };
  },
  toValue(v) {
    return Bytes6Descriptor.toValue(v.domain_sep).concat(Bytes32Descriptor.toValue(v.data));
  },
};

// ── Contract preimage structs (field order/types MUST match the .compact) ──

// struct TokenPreimage { domainSep: Bytes<32>, gameId: Bytes<32>,
//   turn: Uint<16>, kind: Uint<8>, cell: Uint<8>, size: Uint<8>, secret: Bytes<32> }
export type TokenPreimage = {
  domainSep: Uint8Array;
  gameId: Uint8Array;
  turn: bigint;
  kind: bigint;
  cell: bigint;
  size: bigint;
  secret: Uint8Array;
};
export const TokenPreimageDescriptor: CompactType<TokenPreimage> = {
  alignment: () =>
    Bytes32Descriptor.alignment()
      .concat(Bytes32Descriptor.alignment())
      .concat(Uint16Descriptor.alignment())
      .concat(Uint8Descriptor.alignment())
      .concat(Uint8Descriptor.alignment())
      .concat(Uint8Descriptor.alignment())
      .concat(Bytes32Descriptor.alignment()),
  fromValue(v) {
    return {
      domainSep: Bytes32Descriptor.fromValue(v),
      gameId: Bytes32Descriptor.fromValue(v),
      turn: Uint16Descriptor.fromValue(v),
      kind: Uint8Descriptor.fromValue(v),
      cell: Uint8Descriptor.fromValue(v),
      size: Uint8Descriptor.fromValue(v),
      secret: Bytes32Descriptor.fromValue(v),
    };
  },
  toValue(v) {
    return Bytes32Descriptor.toValue(v.domainSep)
      .concat(Bytes32Descriptor.toValue(v.gameId))
      .concat(Uint16Descriptor.toValue(v.turn))
      .concat(Uint8Descriptor.toValue(v.kind))
      .concat(Uint8Descriptor.toValue(v.cell))
      .concat(Uint8Descriptor.toValue(v.size))
      .concat(Bytes32Descriptor.toValue(v.secret));
  },
};

// struct IndexPreimage { domainSep, gameId: Bytes<32>, turn: Uint<16>,
//   slot: Uint<8>, b0..b3: Uint<8>, secret: Bytes<32> }
export type IndexPreimage = {
  domainSep: Uint8Array;
  gameId: Uint8Array;
  turn: bigint;
  slot: bigint;
  b0: bigint;
  b1: bigint;
  b2: bigint;
  b3: bigint;
  secret: Uint8Array;
};
export const IndexPreimageDescriptor: CompactType<IndexPreimage> = {
  alignment: () =>
    Bytes32Descriptor.alignment()
      .concat(Bytes32Descriptor.alignment())
      .concat(Uint16Descriptor.alignment())
      .concat(Uint8Descriptor.alignment())
      .concat(Uint8Descriptor.alignment())
      .concat(Uint8Descriptor.alignment())
      .concat(Uint8Descriptor.alignment())
      .concat(Uint8Descriptor.alignment())
      .concat(Bytes32Descriptor.alignment()),
  fromValue(v) {
    return {
      domainSep: Bytes32Descriptor.fromValue(v),
      gameId: Bytes32Descriptor.fromValue(v),
      turn: Uint16Descriptor.fromValue(v),
      slot: Uint8Descriptor.fromValue(v),
      b0: Uint8Descriptor.fromValue(v),
      b1: Uint8Descriptor.fromValue(v),
      b2: Uint8Descriptor.fromValue(v),
      b3: Uint8Descriptor.fromValue(v),
      secret: Bytes32Descriptor.fromValue(v),
    };
  },
  toValue(v) {
    return Bytes32Descriptor.toValue(v.domainSep)
      .concat(Bytes32Descriptor.toValue(v.gameId))
      .concat(Uint16Descriptor.toValue(v.turn))
      .concat(Uint8Descriptor.toValue(v.slot))
      .concat(Uint8Descriptor.toValue(v.b0))
      .concat(Uint8Descriptor.toValue(v.b1))
      .concat(Uint8Descriptor.toValue(v.b2))
      .concat(Uint8Descriptor.toValue(v.b3))
      .concat(Bytes32Descriptor.toValue(v.secret));
  },
};

// struct RandomPreimage { domainSep, gameId: Bytes<32>, turn: Uint<16>,
//   slot: Uint<8>, b0..b3: Uint<8>, random: Bytes<32> }
export type RandomPreimage = {
  domainSep: Uint8Array;
  gameId: Uint8Array;
  turn: bigint;
  slot: bigint;
  b0: bigint;
  b1: bigint;
  b2: bigint;
  b3: bigint;
  random: Uint8Array;
};
export const RandomPreimageDescriptor: CompactType<RandomPreimage> = {
  alignment: () =>
    Bytes32Descriptor.alignment()
      .concat(Bytes32Descriptor.alignment())
      .concat(Uint16Descriptor.alignment())
      .concat(Uint8Descriptor.alignment())
      .concat(Uint8Descriptor.alignment())
      .concat(Uint8Descriptor.alignment())
      .concat(Uint8Descriptor.alignment())
      .concat(Uint8Descriptor.alignment())
      .concat(Bytes32Descriptor.alignment()),
  fromValue(v) {
    return {
      domainSep: Bytes32Descriptor.fromValue(v),
      gameId: Bytes32Descriptor.fromValue(v),
      turn: Uint16Descriptor.fromValue(v),
      slot: Uint8Descriptor.fromValue(v),
      b0: Uint8Descriptor.fromValue(v),
      b1: Uint8Descriptor.fromValue(v),
      b2: Uint8Descriptor.fromValue(v),
      b3: Uint8Descriptor.fromValue(v),
      random: Bytes32Descriptor.fromValue(v),
    };
  },
  toValue(v) {
    return Bytes32Descriptor.toValue(v.domainSep)
      .concat(Bytes32Descriptor.toValue(v.gameId))
      .concat(Uint16Descriptor.toValue(v.turn))
      .concat(Uint8Descriptor.toValue(v.slot))
      .concat(Uint8Descriptor.toValue(v.b0))
      .concat(Uint8Descriptor.toValue(v.b1))
      .concat(Uint8Descriptor.toValue(v.b2))
      .concat(Uint8Descriptor.toValue(v.b3))
      .concat(Bytes32Descriptor.toValue(v.random));
  },
};

// ── Domain separators ──────────────────────────────────────────────────────

const enc = new TextEncoder();

export function pad32(s: string): Uint8Array {
  const bytes = enc.encode(s);
  if (bytes.length > 32) throw new Error(`string "${s}" exceeds 32 bytes`);
  const out = new Uint8Array(32);
  out.set(bytes, 0);
  return out;
}

export function pad6(s: string): Uint8Array {
  const bytes = enc.encode(s);
  if (bytes.length > 6) throw new Error(`string "${s}" exceeds 6 bytes`);
  const out = new Uint8Array(6);
  out.set(bytes, 0);
  return out;
}

export const DOMAIN_PLAYER_ID = pad32("nixnax:id:");
export const DOMAIN_TOKEN_OTK = pad32("nixnax:otk:");
export const DOMAIN_INDEX = pad32("nixnax:idx:");
export const DOMAIN_RANDOM = pad32("nixnax:rnd:");
export const DOMAIN_STDLIB_LEAF_HASH = pad6("mdn:lh");

// ── High-level hashes used by both sides (TS ↔ in-circuit must match) ──────

function assertBits4(bits: readonly number[]): void {
  if (bits.length !== 4 || bits.some((b) => b !== 0 && b !== 1)) {
    throw new Error("bits must be exactly four 0/1 values");
  }
}

// playerId(gameId, secret) = persistentHash<Vector<3, Bytes<32>>>(
//   [pad(32, "nixnax:id:"), gameId, secret]) — identity is scoped per game.
export function computePlayerId(gameId: Uint8Array, secret: Uint8Array): Uint8Array {
  if (gameId.length !== 32) throw new Error("gameId must be 32 bytes");
  if (secret.length !== 32) throw new Error("secret must be 32 bytes");
  return persistentHash(Vector3Bytes32Descriptor, [DOMAIN_PLAYER_ID, gameId, secret]);
}

// tokenLeaf(gameId, turn, kind, cell, size, secret)
export function computeTokenLeaf(
  gameId: Uint8Array,
  turn: number,
  kind: number,
  cell: number,
  size: number,
  secret: Uint8Array,
): Uint8Array {
  if (gameId.length !== 32) throw new Error("gameId must be 32 bytes");
  if (secret.length !== 32) throw new Error("secret must be 32 bytes");
  if (turn < 0 || turn > 65535) throw new Error("turn out of range");
  if (kind < 0 || kind > 255) throw new Error("kind out of range");
  if (cell < 0 || cell > 255) throw new Error("cell out of range");
  if (size < 0 || size > 255) throw new Error("size out of range");
  return persistentHash(TokenPreimageDescriptor, {
    domainSep: DOMAIN_TOKEN_OTK,
    gameId,
    turn: BigInt(turn),
    kind: BigInt(kind),
    cell: BigInt(cell),
    size: BigInt(size),
    secret,
  });
}

// indexLeaf(gameId, turn, slot, bits[4], secret)
export function computeIndexLeaf(
  gameId: Uint8Array,
  turn: number,
  slot: number,
  bits: readonly number[],
  secret: Uint8Array,
): Uint8Array {
  if (gameId.length !== 32) throw new Error("gameId must be 32 bytes");
  if (secret.length !== 32) throw new Error("secret must be 32 bytes");
  assertBits4(bits);
  return persistentHash(IndexPreimageDescriptor, {
    domainSep: DOMAIN_INDEX,
    gameId,
    turn: BigInt(turn),
    slot: BigInt(slot),
    b0: BigInt(bits[0]),
    b1: BigInt(bits[1]),
    b2: BigInt(bits[2]),
    b3: BigInt(bits[3]),
    secret,
  });
}

// randomLeaf(gameId, turn, slot, bits[4], random)
export function computeRandomLeaf(
  gameId: Uint8Array,
  turn: number,
  slot: number,
  bits: readonly number[],
  random: Uint8Array,
): Uint8Array {
  if (gameId.length !== 32) throw new Error("gameId must be 32 bytes");
  if (random.length !== 32) throw new Error("random must be 32 bytes");
  assertBits4(bits);
  return persistentHash(RandomPreimageDescriptor, {
    domainSep: DOMAIN_RANDOM,
    gameId,
    turn: BigInt(turn),
    slot: BigInt(slot),
    b0: BigInt(bits[0]),
    b1: BigInt(bits[1]),
    b2: BigInt(bits[2]),
    b3: BigInt(bits[3]),
    random,
  });
}

// ── Std-lib merkleTreePathRoot mirror ──────────────────────────────────────

// degradeToTransient(persistentHash(LeafPreimage{domain_sep: "mdn:lh", data: leaf}))
export function hashLeafToField(leaf: Uint8Array): bigint {
  if (leaf.length !== 32) throw new Error("leaf must be 32 bytes");
  const hash = persistentHash(LeafPreimage32Descriptor, {
    domain_sep: DOMAIN_STDLIB_LEAF_HASH,
    data: leaf,
  });
  return degradeToTransient(hash);
}

export function combinePathEntry(
  recursiveDigest: bigint,
  entry: { sibling: { field: bigint }; goes_left: boolean },
): bigint {
  const left = entry.goes_left ? recursiveDigest : entry.sibling.field;
  const right = entry.goes_left ? entry.sibling.field : recursiveDigest;
  return transientHash(Vector2FieldDescriptor, [left, right]);
}

export function merklePathRootField(
  leaf: Uint8Array,
  path: { sibling: { field: bigint }; goes_left: boolean }[],
): bigint {
  let acc = hashLeafToField(leaf);
  for (const entry of path) {
    acc = combinePathEntry(acc, entry);
  }
  return acc;
}

// ── Randomness ─────────────────────────────────────────────────────────────

export function randomBytes32(): Uint8Array {
  const out = new Uint8Array(32);
  globalThis.crypto.getRandomValues(out);
  return out;
}

export function randomBit(): number {
  const b = new Uint8Array(1);
  globalThis.crypto.getRandomValues(b);
  return b[0] & 1;
}

export function randomGameId(): Uint8Array {
  return randomBytes32();
}

// Generic hash of a byte sequence (used for the SignedMove hash-link).
export function hashBytes(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const flat = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    flat.set(c, off);
    off += c.length;
  }
  // Project arbitrary-length flat input into a 32-byte rolling hash so the
  // outer call hashes within the typed descriptor system.
  let acc: Uint8Array = new Uint8Array(32);
  const blockSize = 32;
  for (let i = 0; i < flat.length; i += blockSize) {
    const block = new Uint8Array(blockSize);
    block.set(flat.subarray(i, Math.min(i + blockSize, flat.length)));
    const next: Uint8Array = persistentHash(Vector2Bytes32Descriptor, [acc, block]);
    acc = next;
  }
  return acc;
}

// ── Generic bottom-up tree builder shared by the three tree modules ────────

export type PathEntry = { sibling: { field: bigint }; goes_left: boolean };
export type MerklePath = { leaf: Uint8Array; path: PathEntry[] };

export function buildMerkleLevels(leafBytes: Uint8Array[], depth: number): bigint[][] {
  if (leafBytes.length !== 1 << depth) throw new Error("leaf count must be 2^depth");
  const levels: bigint[][] = [];
  levels[0] = leafBytes.map(hashLeafToField);
  for (let d = 1; d <= depth; d++) {
    const prev = levels[d - 1];
    const cur: bigint[] = new Array(prev.length / 2);
    for (let i = 0; i < cur.length; i++) {
      cur[i] = combinePathEntry(prev[2 * i], { sibling: { field: prev[2 * i + 1] }, goes_left: true });
    }
    levels[d] = cur;
  }
  return levels;
}

export function pathFromLevels(
  levels: bigint[][],
  leafBytes: Uint8Array[],
  leafIndex: number,
  depth: number,
): MerklePath {
  let idx = leafIndex;
  const path: PathEntry[] = [];
  for (let d = 0; d < depth; d++) {
    path.push({
      sibling: { field: levels[d][idx ^ 1] },
      goes_left: (idx & 1) === 0,
    });
    idx = idx >>> 1;
  }
  return { leaf: leafBytes[leafIndex], path };
}
