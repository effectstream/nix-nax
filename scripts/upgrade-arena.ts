/**
 * Upgrade a DEPLOYED NixNaxArena in place: install verifier keys for circuits
 * the deployment doesn't have yet. The arena address, all open games, and
 * every existing circuit stay untouched — this only ADDS entry points.
 *
 * Requirements:
 *   * Run on the SAME machine (and repo) that deployed the arena: maintenance
 *     txs are signed with the contract's maintenance key, which lives in the
 *     deployer's local signing-key store (nixnax-level-db-arena/).
 *   * The same funded wallet (MN_MNEMONIC / MN_SEED) — one small tx per key.
 *   * `bun run compact` beforehand, so managed/keys holds the new circuits.
 *   * No proof server needed: VK inserts are signed maintenance txs, not ZK.
 *
 * Usage:
 *   MN_ENV=preview MN_MNEMONIC="word1 … word24" bun run upgrade:arena
 *   MN_ENV=preview MN_SEED=<hex> bun run upgrade:arena
 *   MN_ENV=undeployed bun run upgrade:arena       (genesis seed, local chain)
 *
 * The target address resolves from nixnax.<network>.json (written by
 * deploy:net), overridable with MN_ARENA_ADDRESS.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveNetwork, resolveSeed, exportToSdkEnv } from "./net-env.ts";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

async function resolveAddress(networkId: string): Promise<string> {
  const fromEnv = process.env.MN_ARENA_ADDRESS?.trim();
  if (fromEnv) return fromEnv;
  const cache = path.join(REPO_ROOT, `nixnax.${networkId}.json`);
  if (existsSync(cache)) {
    const saved = JSON.parse(await readFile(cache, "utf8")) as { contractAddress?: string };
    if (saved.contractAddress) return saved.contractAddress;
  }
  throw new Error(
    `no arena address: set MN_ARENA_ADDRESS or run deploy:net first (missing ${cache})`,
  );
}

async function main() {
  const env = (process.env.MN_ENV ?? "preview").trim();
  const net = resolveNetwork(env);
  const seed = resolveSeed(env);
  const address = await resolveAddress(net.networkId);

  console.log(`[upgrade] env=${env} networkId=${net.networkId}`);
  console.log(`[upgrade] arena=${address}`);
  console.log(`[upgrade] node=${net.node}`);

  // src/sdk/env.ts reads process.env at module load — set before importing.
  exportToSdkEnv(net);
  const { NETWORK } = await import("../src/sdk/env.ts");
  const { buildAndFundWallet, insertMissingVerifierKeys } = await import("../src/sdk/deploy.ts");

  console.log("[upgrade] building + syncing wallet…");
  const wallet = await buildAndFundWallet(NETWORK, seed);

  const res = await insertMissingVerifierKeys({ wallet, contractAddress: address });
  if (res.inserted.length === 0) {
    console.log(`\n[upgrade] nothing to do — all ${res.present.length} circuits already installed.`);
  } else {
    console.log(`\n✅ upgraded arena ${address}`);
    console.log(`   installed: ${res.inserted.join(", ")}`);
    console.log(`   (previously present: ${res.present.length} circuits)`);
    console.log(`\nThe frontend can now use the new settle variants — rebuild + redeploy the webapp.`);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
    console.error("[upgrade] failed:", msg);
    if (/signing key|signingKey|unauthorized|authority/i.test(String(msg))) {
      console.error(
        "\nThe maintenance key for this arena was not found — VK inserts must run on the\n" +
        "machine (and repo) that originally deployed it, with the same signing-key store\n" +
        "(nixnax-level-db-arena/).",
      );
    }
    process.exit(1);
  },
);
