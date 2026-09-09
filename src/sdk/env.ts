// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

// Network endpoints + constants.
//
// Defaults match the local-undeployed stack started by `bun run stack:up`:
//   * node       http://127.0.0.1:9944        (substrate JSON-RPC)
//   * indexer    http://127.0.0.1:8088/api/v3/graphql (HTTP + ws)
//   * proof      http://127.0.0.1:6300        (httpClientProofProvider)
//
// Override via MIDNIGHT_NODE_URL / MIDNIGHT_INDEXER_URL / MIDNIGHT_INDEXER_WS /
// MIDNIGHT_PROOF_SERVER_URL when pointing at a remote network.

import { NetworkId } from "@midnight-ntwrk/wallet-sdk-abstractions";

export interface NetworkUrls {
  indexer: string;
  indexerWS: string;
  node: string;
  proofServer: string;
  networkId: NetworkId.NetworkId;
}

const env = (k: string, fallback: string) => process.env[k]?.trim() || fallback;

export const NETWORK: NetworkUrls = {
  indexer: env("MIDNIGHT_INDEXER_URL", "http://127.0.0.1:8088/api/v3/graphql"),
  indexerWS: env("MIDNIGHT_INDEXER_WS_URL", "ws://127.0.0.1:8088/api/v3/graphql/ws"),
  node: env("MIDNIGHT_NODE_URL", "http://127.0.0.1:9944"),
  proofServer: env("MIDNIGHT_PROOF_SERVER_URL", "http://127.0.0.1:6300"),
  networkId: (env("MIDNIGHT_NETWORK_ID", "undeployed") as NetworkId.NetworkId),
};

// Genesis-funded wallet seed on a local `undeployed` chain.
export const GENESIS_SEED =
  env("MIDNIGHT_WALLET_SEED", "0000000000000000000000000000000000000000000000000000000000000001");

export const CONSTANTS = {
  TTL_DURATION_MS: 60 * 60 * 1000,
  WALLET_SYNC_THROTTLE_MS: 5_000,
  WALLET_SYNC_TIMEOUT_MS: 600_000,
  DUST_FEE_OVERHEAD: 300_000_000_000_000n,
  DUST_FEE_BLOCKS_MARGIN: 5,
  STORAGE_PASSWORD: env("MIDNIGHT_STORAGE_PASSWORD", "YourPasswordMy1!"),
} as const;
