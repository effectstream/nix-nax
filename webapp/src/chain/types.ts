// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

// Browser-facing contract types. UI and orchestration code can import this
// module without loading the compiled contract or provider runtime.

import type { Contract as GeneratedContract } from "../../../src/contract/managed/contract/index.js";
import type { NixNaxPrivateState, NixNaxWitnesses } from "../../../src/contract/index.ts";
import type { WirePath } from "../../../src/sdk/game/messaging.ts";
import type { ContractProviders, FoundContract } from "@midnight-ntwrk/midnight-js-contracts";

export type NixNaxContract = GeneratedContract<NixNaxPrivateState, NixNaxWitnesses>;
export type ArenaProviders = ContractProviders<NixNaxContract>;
export type ArenaFoundContract = FoundContract<NixNaxContract>;

export interface ArenaAttachment {
  found: ArenaFoundContract;
  providers: ArenaProviders;
  addr: string;
}

export type { WirePath } from "../../../src/sdk/game/messaging.ts";

export interface ContractState {
  ok: true;
  gameId: string;
  status: number;
  statusName: "halfOpen" | "inProgress" | "settled";
  winner: number;
  winnerName: "none" | "x" | "o" | "draw";
  idX: string;
  idO: string;
  rootX: string;
  rootO: string;
  committedTurns: number;
  turnMark: number;
  board: number[];
  tops: number[];
  reserves: Record<string, number>;
  actionLog: { turn: number; packed: number }[];
}

export interface CreateGameArgs {
  gameId: string;
  idX: string;
  rootX: string;
}

export interface JoinGameArgs {
  gameId: string;
  idO: string;
  rootO: string;
}

export interface SettleChunkBody {
  gameId: string;
  nMoves: number;
  kinds: number[];
  cells: number[];
  sizes: number[];
  secrets: string[];
  paths: WirePath[];
}

export interface TransactionResult {
  ok: true;
  txId: string;
}

export interface CreateGameResult extends TransactionResult {
  gameId: string;
}

export interface ArenaApi {
  health(): Promise<{ ok: true; arena?: string }>;
  createGame(args: CreateGameArgs): Promise<CreateGameResult>;
  join(args: JoinGameArgs): Promise<TransactionResult>;
  state(gameId: string): Promise<ContractState>;
  settle(body: SettleChunkBody): Promise<TransactionResult>;
  claimResult(gameId: string, secret: string): Promise<TransactionResult>;
}
