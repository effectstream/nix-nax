// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

// Re-export the compiled contract module + witness wiring.
//
// Keeps the generated managed/contract module and its witness wiring
// importable through one maintained advanced-contract entry point.

export * as NixNaxArena from "./managed/contract/index.js";
export type { Ledger, Status, Winner, Witnesses } from "./managed/contract/index.js";
export { Contract, ledger } from "./managed/contract/index.js";
export {
  createWitnesses,
  createNixNaxPrivateState,
  type NixNaxPrivateState,
  type NixNaxWitnesses,
} from "./witnesses.ts";
