// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

// Dev-chain faucet CLI: send NIGHT from the genesis wallet to any address —
// e.g. a Lace/extension wallet connected to the local `undeployed` network
// (the in-app Wallet modal has a button that does the same).
//
//   bun run faucet -- <mn_addr_undeployed1…>          (50_000_000_000_000 NIGHT)
//   bun run faucet -- <address> <amount>
//
// Undeployed-only: the genesis seed holds funds only on the local dev chain.
// The receiving wallet registers the NIGHT for dust (gas) generation itself.

import { unshieldedToken } from "@midnight-ntwrk/ledger-v8";
import { MidnightBech32m, UnshieldedAddress } from "@midnight-ntwrk/wallet-sdk-address-format";
import { NETWORK } from "../src/sdk/env.ts";
import { buildAndFundWallet } from "../src/sdk/wallet.ts";

const [address, amountArg] = process.argv.slice(2);
if (!address?.startsWith("mn_")) {
  console.error("usage: bun run faucet -- <mn_addr_…> [amount]");
  process.exit(1);
}
if (NETWORK.networkId !== "undeployed") {
  console.error(`faucet is undeployed-only (network is "${NETWORK.networkId}")`);
  process.exit(1);
}
const amount = BigInt(amountArg ?? "50000000000000");

const receiverAddress = MidnightBech32m.parse(address).decode(
  UnshieldedAddress as any,
  NETWORK.networkId as any,
);

// The dev chain seeds …01/…02/…03 with NIGHT; earlier faucet runs may have
// drained the first — use the first seed that can cover the amount.
const GENESIS_SEEDS = ["01", "02", "03"].map((n) => "00".repeat(31) + n);
let main;
for (const seed of GENESIS_SEEDS) {
  console.log(`faucet: checking genesis …${seed.slice(-2)} wallet…`);
  const candidate = await buildAndFundWallet(NETWORK, seed);
  const { waitForFunds } = await import("../src/sdk/wallet.ts");
  const funds = await waitForFunds(candidate, { requireShielded: false });
  if (funds.unshielded >= amount) { main = candidate; break; }
  console.log(`faucet: …${seed.slice(-2)} has only ${funds.unshielded} NIGHT — trying next seed`);
}
if (!main) {
  console.error("all genesis dev seeds are out of NIGHT — restart the dev chain to re-mint");
  process.exit(1);
}

console.log(`faucet: sending ${amount} NIGHT → ${address.slice(0, 28)}…`);
const recipe = await (main.wallet as any).transferTransaction(
  [{ type: "unshielded", outputs: [{ amount, receiverAddress, type: unshieldedToken().raw }] }],
  { shieldedSecretKeys: main.zswapSecretKeys, dustSecretKey: main.dustSecretKey },
  { ttl: new Date(Date.now() + 30 * 60 * 1000) },
);
const signed = await main.wallet.signRecipe(recipe, (p) => main.unshieldedKeystore.signData(p));
const finalized = await main.wallet.finalizeRecipe(signed);
const txHash = await main.wallet.submitTransaction(finalized);
console.log(`✅ faucet tx ${txHash}`);
console.log(`   NIGHT will appear in the wallet shortly. Register it for dust (gas) from the wallet's own UI.`);
process.exit(0);
