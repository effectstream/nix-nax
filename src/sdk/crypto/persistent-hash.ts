// Thin TS wrappers around `@midnight-ntwrk/compact-runtime` hashing primitives.
//
// Everything here mirrors the IN-CIRCUIT algorithm of TicTacToeChannel.compact
// and the standard library's `merkleTreePathRoot`. The token-tree module
// composes these to build / verify the per-(turn, cell) one-time tokens that
// authorise off-chain moves.
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
export const FieldDescriptor = CompactTypeField;

export const Vector2Bytes32Descriptor = new CompactTypeVector(2, Bytes32Descriptor);
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

// ── Our contract's `TokenPreimage` struct ──────────────────────────────────
// struct TokenPreimage { domainSep: Bytes<32>, turn: Uint<8>, cell: Uint<8>, secret: Bytes<32> }

export type TokenPreimage = {
  domainSep: Uint8Array;
  turn: bigint;
  cell: bigint;
  secret: Uint8Array;
};
export const TokenPreimageDescriptor: CompactType<TokenPreimage> = {
  alignment: () =>
    Bytes32Descriptor.alignment()
      .concat(Uint8Descriptor.alignment())
      .concat(Uint8Descriptor.alignment())
      .concat(Bytes32Descriptor.alignment()),
  fromValue(v) {
    return {
      domainSep: Bytes32Descriptor.fromValue(v),
      turn: Uint8Descriptor.fromValue(v),
      cell: Uint8Descriptor.fromValue(v),
      secret: Bytes32Descriptor.fromValue(v),
    };
  },
  toValue(v) {
    return Bytes32Descriptor.toValue(v.domainSep)
      .concat(Uint8Descriptor.toValue(v.turn))
      .concat(Uint8Descriptor.toValue(v.cell))
      .concat(Bytes32Descriptor.toValue(v.secret));
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

export const DOMAIN_PLAYER_ID = pad32("ttt:id:");
export const DOMAIN_TOKEN_OTK = pad32("ttt:otk:");
export const DOMAIN_STDLIB_LEAF_HASH = pad6("mdn:lh");
export const DOMAIN_CHANNEL_LINK = pad32("ttt:link:");

// ── High-level hashes used by both sides (TS ↔ in-circuit must match) ──────

// playerId(secret) = persistentHash<Vector<2, Bytes<32>>>([pad(32, "ttt:id:"), secret])
export function computePlayerId(secret: Uint8Array): Uint8Array {
  if (secret.length !== 32) throw new Error("secret must be 32 bytes");
  return persistentHash(Vector2Bytes32Descriptor, [DOMAIN_PLAYER_ID, secret]);
}

// tokenLeaf(turn, cell, secret) = persistentHash<TokenPreimage>(...)
export function computeTokenLeaf(turn: number, cell: number, secret: Uint8Array): Uint8Array {
  if (secret.length !== 32) throw new Error("secret must be 32 bytes");
  if (turn < 0 || turn > 255) throw new Error("turn out of range");
  if (cell < 0 || cell > 255) throw new Error("cell out of range");
  return persistentHash(TokenPreimageDescriptor, {
    domainSep: DOMAIN_TOKEN_OTK,
    turn: BigInt(turn),
    cell: BigInt(cell),
    secret,
  });
}

// degradeToTransient(persistentHash(LeafPreimage{domain_sep: "mdn:lh", data: leaf}))
// — first step of std-lib merkleTreePathRoot.
export function hashLeafToField(leaf: Uint8Array): bigint {
  if (leaf.length !== 32) throw new Error("leaf must be 32 bytes");
  const hash = persistentHash(LeafPreimage32Descriptor, {
    domain_sep: DOMAIN_STDLIB_LEAF_HASH,
    data: leaf,
  });
  return degradeToTransient(hash);
}

// One layer of merkle path combination — Compact std-lib `merkleTreePathEntryRoot`.
export function combinePathEntry(
  recursiveDigest: bigint,
  entry: { sibling: { field: bigint }; goes_left: boolean }
): bigint {
  const left = entry.goes_left ? recursiveDigest : entry.sibling.field;
  const right = entry.goes_left ? entry.sibling.field : recursiveDigest;
  return transientHash(Vector2FieldDescriptor, [left, right]);
}

// Full merkleTreePathRoot<N, Bytes<32>> as bigint Field.
export function merklePathRootField(
  leaf: Uint8Array,
  path: { sibling: { field: bigint }; goes_left: boolean }[]
): bigint {
  let acc = hashLeafToField(leaf);
  for (const entry of path) {
    acc = combinePathEntry(acc, entry);
  }
  return acc;
}

// 32 bytes of cryptographic randomness for sampling secrets.
// Both Node 19+ and browsers expose globalThis.crypto.getRandomValues.
export function randomBytes32(): Uint8Array {
  const out = new Uint8Array(32);
  globalThis.crypto.getRandomValues(out);
  return out;
}

// Generic hash of a byte sequence (used for the SignedMove hash-link).
export function hashBytes(...chunks: Uint8Array[]): Uint8Array {
  // We model the channel chain link as persistentHash<Vector<2, Bytes<32>>>([domain, payload])
  // where payload is the hash of all chunks concatenated. Simple but stable.
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
