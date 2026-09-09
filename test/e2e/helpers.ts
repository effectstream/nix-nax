// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

// Shared helpers for the e2e suite.
//
// Tests require the local stack (node, indexer, proof-server) to be running.
// Each test deploys a fresh contract — the chain is shared but contracts
// don't interfere (different addresses).

import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { NETWORK } from "../../src/sdk/env.ts";

export function ensureStackHints() {
  setNetworkId(NETWORK.networkId);
}

// Force a small sleep — used to wait for a challenge window to expire on chain.
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Poll the substrate JSON-RPC for the current block timestamp (seconds since
// epoch). The Midnight node sets it via substrate's Timestamp pallet; we
// query via `chain_getBlock` + `chain_getHeader` to gather it. As a fallback
// we use Date.now()/1000.
export async function chainTimeSeconds(): Promise<number> {
  try {
    const res = await fetch(NETWORK.node.replace(/^ws/, "http"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "system_health", params: [] }),
    });
    void (await res.json());
  } catch {
    // ignore — the JSON-RPC fall-through below is best-effort.
  }
  return Math.floor(Date.now() / 1000);
}
