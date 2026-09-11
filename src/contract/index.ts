// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

// Re-export the compiled contract module + witness wiring.
//
// Mirrors the pattern of pe-bun-3's contract-counter/src/index.ts — making
// the generated managed/contract module importable as a single namespace.

export * as NixNaxArena from "./managed/contract/index.js";
export type { Ledger, Status, Winner, Witnesses } from "./managed/contract/index.js";
export { Contract, ledger } from "./managed/contract/index.js";
export {
  createWitnesses,
  createNixNaxPrivateState,
  type NixNaxPrivateState,
  type NixNaxWitnesses,
} from "./witnesses.ts";
