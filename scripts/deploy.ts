// One-time arena deployment for the serverless (client-side) webapp.
//
// Deploys NixNaxArena once (or reuses the persisted deployment) using the
// genesis wallet, then writes the contract address to webapp/public/arena.json
// so the browser dApp can attach by address — no relay needed.
//
//   bun run scripts/deploy.ts        (run once, after `bun run stack:up`)
//
// Reuses the heavy lifting (stub deploy + per-circuit verifier-key inserts to
// dodge block limits) already implemented in src/sdk/deploy.ts.

import { writeFile, mkdir } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { NETWORK } from "../src/sdk/env.ts";
import { buildAndFundWallet, ensureArenaDeployed } from "../src/sdk/deploy.ts";

const GENESIS_SEED =
  process.env.MIDNIGHT_WALLET_SEED ??
  "0000000000000000000000000000000000000000000000000000000000000001";

const ARENA_JSON = path.resolve(
  fileURLToPath(new URL("../webapp/public/arena.json", import.meta.url)),
);

console.log("deploy: building + funding the genesis wallet…");
const wallet = await buildAndFundWallet(NETWORK, GENESIS_SEED);

console.log("deploy: ensuring the arena is deployed…");
const arena = await ensureArenaDeployed({ wallet });
console.log(`deploy: arena ${arena.reused ? "reused" : "deployed"} at ${arena.contractAddress}`);

await mkdir(path.dirname(ARENA_JSON), { recursive: true });
await writeFile(
  ARENA_JSON,
  JSON.stringify({ contractAddress: arena.contractAddress, networkId: NETWORK.networkId }, null, 2) + "\n",
);
console.log(`deploy: wrote ${ARENA_JSON}`);
console.log(
  `deploy: for a production webapp build, record this in the root .env:\n` +
  `  VITE_ARENA_ADDRESS_${String(NETWORK.networkId).toUpperCase()}=${arena.contractAddress}`,
);

// Wallet/providers hold open indexer subscriptions + LevelDB; exit explicitly.
process.exit(0);
