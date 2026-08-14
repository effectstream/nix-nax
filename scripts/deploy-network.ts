/**
 * Deploy NixNaxArena to a chosen Midnight network and record the contract
 * address in the repo-root .env as `VITE_ARENA_ADDRESS_<NETWORK>` — the exact
 * variable the webapp bundle reads at build time (see webapp/src/chain/env.ts).
 *
 * Models scripts/deploy.ts (the local one-shot) + the contract-convert-vault
 * deploy flow: resolve a network, build+fund a wallet from a mnemonic/seed,
 * run the full 17-tx arena deploy (stub + 16 verifier keys), persist the
 * address. Deploying to a hosted network needs a FUNDED, DUST-REGISTERED
 * wallet and a LOCAL proof server (proving is local; only node/indexer are
 * remote) — run `bun run stack:up` (or just a proof-server 8.1.0 at :6300).
 *
 * Usage:
 *   # from a BIP-39 mnemonic (e.g. exported from Lace) — quote it:
 *   MN_ENV=preview MN_MNEMONIC="word1 word2 … word24" bun run scripts/deploy-network.ts
 *
 *   # or from a raw hex seed:
 *   MN_ENV=preview MN_SEED=<hex-seed> bun run scripts/deploy-network.ts
 *
 *   # local dev chain (uses the genesis seed automatically):
 *   MN_ENV=undeployed bun run scripts/deploy-network.ts
 *
 * Env:
 *   MN_ENV                undeployed | preview | preprod | mainnet | testnet | qanet
 *                         (default: preview)
 *   MN_MNEMONIC           BIP-39 phrase; derived to a seed as Lace does
 *   MN_SEED               raw hex seed (alternative to MN_MNEMONIC)
 *   MN_INDEXER_URL        override the network's indexer HTTP URL
 *   MN_INDEXER_WS_URL     override the network's indexer WS URL
 *   MN_NODE_URL           override the network's node RPC URL
 *   MN_PROOF_SERVER_URL   override the proof server (default http://127.0.0.1:6300)
 *   MN_MIN_WINDOW_SECS    sealed min challenge/timeout window (default 600 = 10m)
 *
 * MN_MNEMONIC / MN_SEED can live in the repo-root .env (gitignored) instead of
 * the shell — the shell still takes precedence.
 *
 * NOTE: the hosted indexer defaults use the `/api/v3/graphql` path to match
 * this repo's indexer 4.3.3 client. If the live network runs a newer indexer
 * (different API path), override with MN_INDEXER_URL / MN_INDEXER_WS_URL.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveNetwork, resolveSeed, exportToSdkEnv } from "./net-env.ts";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const ENV_FILE = path.join(REPO_ROOT, ".env");

// Upsert KEY=VALUE lines into the repo-root .env, preserving everything else.
async function upsertEnv(kv: Record<string, string>): Promise<void> {
  const existing = existsSync(ENV_FILE) ? await readFile(ENV_FILE, "utf8") : "";
  const lines = existing.length ? existing.split("\n") : [];
  // Drop the empty element a trailing newline produces, so appended keys don't
  // land after a blank line (the final join re-adds the trailing newline).
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  for (const [key, value] of Object.entries(kv)) {
    const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
    const line = `${key}=${value}`;
    if (idx >= 0) lines[idx] = line;
    else lines.push(line);
  }
  let out = lines.join("\n");
  if (!out.endsWith("\n")) out += "\n";
  await writeFile(ENV_FILE, out);
}

async function main() {
  const env = (process.env.MN_ENV ?? "preview").trim();
  const net = resolveNetwork(env);
  const seed = resolveSeed(env);
  const suffix = net.networkId.toUpperCase();

  console.log(`[deploy] env=${env} networkId=${net.networkId}`);
  console.log(`[deploy] node=${net.node}`);
  console.log(`[deploy] indexer=${net.indexer}`);
  console.log(`[deploy] proofServer=${net.proofServer}`);

  // Feed the resolved endpoints to the SDK's env module BEFORE importing it —
  // src/sdk/env.ts reads process.env at module load, so this must precede the
  // dynamic imports below (which is why they are dynamic, not top-level).
  exportToSdkEnv(net);

  const { NETWORK } = await import("../src/sdk/env.ts");
  const { buildAndFundWallet, ensureArenaDeployed } = await import("../src/sdk/deploy.ts");

  console.log("[deploy] building + syncing wallet (funds needed on hosted networks)…");
  const wallet = await buildAndFundWallet(NETWORK, seed);

  console.log("[deploy] deploying arena (stub + 4 verifier keys)…");
  const arena = await ensureArenaDeployed({
    wallet,
    // Per-network deployment cache so networks never reuse each other's arena.
    deploymentFile: path.join(REPO_ROOT, `nixnax.${net.networkId}.json`),
  });
  console.log(`[deploy] arena ${arena.reused ? "reused" : "deployed"} at ${arena.contractAddress}`);

  // Record what the webapp build needs for this network. Proof server is
  // intentionally NOT written: the value used here is the LOCAL deploy-time one;
  // a served webapp needs a PUBLIC proof server reachable by players' browsers.
  const written: Record<string, string> = {
    [`VITE_ARENA_ADDRESS_${suffix}`]: arena.contractAddress,
    [`VITE_INDEXER_URL_${suffix}`]: net.indexer,
    [`VITE_INDEXER_WS_URL_${suffix}`]: net.indexerWS,
    [`VITE_NODE_URL_${suffix}`]: net.node,
  };
  await upsertEnv(written);
  console.log(`\n[deploy] wrote ${ENV_FILE}:`);
  for (const [k, v] of Object.entries(written)) console.log(`  ${k}=${v}`);
  console.log(`\n[deploy] still needed for a webapp build on ${net.networkId}:`);
  console.log(`  VITE_NETWORK_ID=${net.networkId}`);
  console.log(`  VITE_PROOF_SERVER_URL_${suffix}=<public proof server reachable by browsers>`);

  // On the local dev chain the browser falls back to arena.json; keep it fresh.
  // Hosted networks read the address from VITE_ARENA_ADDRESS_* instead.
  if (net.networkId === "undeployed") {
    const arenaJson = path.join(REPO_ROOT, "webapp", "public", "arena.json");
    await mkdir(path.dirname(arenaJson), { recursive: true });
    await writeFile(
      arenaJson,
      JSON.stringify({ contractAddress: arena.contractAddress, networkId: net.networkId }, null, 2) + "\n",
    );
    console.log(`[deploy] wrote ${arenaJson}`);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error("[deploy] failed:", e instanceof Error ? (e.stack ?? e.message) : e);
    process.exit(1);
  },
);
