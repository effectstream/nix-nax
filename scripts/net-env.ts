// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

// Shared MN_* environment resolution for the network scripts
// (deploy-network.ts, upgrade-arena.ts): pick a network by MN_ENV, resolve
// endpoints (with MN_*_URL overrides) and the wallet seed (MN_MNEMONIC BIP-39,
// derived as Lace does, or raw MN_SEED hex; genesis seed on `undeployed`).

import { validateMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";

export const GENESIS_SEED = "0000000000000000000000000000000000000000000000000000000000000001";

export interface NetworkConfig {
  indexer: string;
  indexerWS: string;
  node: string;
  proofServer: string;
  networkId: string;
}

// Hosted endpoints follow Midnight's `<svc>.<network>.midnight.network` pattern.
// Proof server is LOCAL for every network — proving happens on this machine and
// only the balanced tx is submitted to the (possibly remote) node.
const LOCAL_PROOF = "http://127.0.0.1:6300";
function hosted(net: string): NetworkConfig {
  return {
    indexer: `https://indexer.${net}.midnight.network/api/v3/graphql`,
    indexerWS: `wss://indexer.${net}.midnight.network/api/v3/graphql/ws`,
    node: `https://rpc.${net}.midnight.network`,
    proofServer: LOCAL_PROOF,
    networkId: net,
  };
}

export const NETWORKS: Record<string, NetworkConfig> = {
  undeployed: {
    indexer: "http://127.0.0.1:8088/api/v3/graphql",
    indexerWS: "ws://127.0.0.1:8088/api/v3/graphql/ws",
    node: "http://127.0.0.1:9944",
    proofServer: LOCAL_PROOF,
    networkId: "undeployed",
  },
  preview: hosted("preview"),
  preprod: hosted("preprod"),
  mainnet: hosted("mainnet"),
  testnet: hosted("testnet"),
  qanet: hosted("qanet"),
};

export function resolveNetwork(env: string): NetworkConfig {
  const base = NETWORKS[env];
  if (!base) {
    throw new Error(`Invalid MN_ENV "${env}". Valid: ${Object.keys(NETWORKS).join(", ")}`);
  }
  const o = (k: string) => process.env[k]?.trim();
  return {
    indexer: o("MN_INDEXER_URL") ?? base.indexer,
    indexerWS: o("MN_INDEXER_WS_URL") ?? base.indexerWS,
    node: o("MN_NODE_URL") ?? base.node,
    proofServer: o("MN_PROOF_SERVER_URL") ?? base.proofServer,
    networkId: base.networkId,
  };
}

// Resolve the wallet seed from MN_MNEMONIC (BIP-39, derived as Lace does) or a
// raw MN_SEED hex, falling back to the local genesis seed on `undeployed`.
export function resolveSeed(env: string): string {
  const mnemonic = process.env.MN_MNEMONIC?.trim().replace(/\s+/g, " ");
  if (mnemonic) {
    if (!validateMnemonic(mnemonic, wordlist)) {
      throw new Error("MN_MNEMONIC is not a valid BIP-39 phrase (bad word or checksum).");
    }
    return Buffer.from(mnemonicToSeedSync(mnemonic)).toString("hex");
  }
  const seed = process.env.MN_SEED?.trim() ?? (env === "undeployed" ? GENESIS_SEED : "");
  if (!seed) {
    throw new Error(`Set MN_MNEMONIC or MN_SEED for MN_ENV=${env} (a funded, DUST-registered wallet).`);
  }
  return seed;
}

// Feed the resolved endpoints to src/sdk/env.ts, which reads process.env at
// module load — call BEFORE dynamically importing anything under src/sdk.
export function exportToSdkEnv(net: NetworkConfig): void {
  process.env.MIDNIGHT_NODE_URL = net.node;
  process.env.MIDNIGHT_INDEXER_URL = net.indexer;
  process.env.MIDNIGHT_INDEXER_WS_URL = net.indexerWS;
  process.env.MIDNIGHT_PROOF_SERVER_URL = net.proofServer;
  process.env.MIDNIGHT_NETWORK_ID = net.networkId;
}
