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
import { NETWORK, GENESIS_SEED } from "../src/sdk/env.ts";
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

console.log(`faucet: building genesis wallet…`);
const main = await buildAndFundWallet(NETWORK, GENESIS_SEED);

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
console.log(`   NIGHT will appear in the wallet shortly; it registers dust (gas) itself.`);
process.exit(0);
