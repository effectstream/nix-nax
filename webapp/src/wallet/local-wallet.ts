// In-browser wallets for the local `undeployed` network — they build, balance
// (pay dust), and submit the player's on-chain txs, replacing the relay's seed
// wallet. Two roles:
//   • genesis ("main") wallet — funded at genesis; the faucet's source.
//   • the active GAS wallet — what on-chain actions pay from. Defaults to genesis
//     (works single-tab); the faucet (faucet.ts) swaps in a funded session wallet.

import { NETWORK, IS_UNDEPLOYED, NETWORK_ID } from "../chain/env.ts";
import { buildAndFundWallet, waitForFunds, type WalletBundle } from "../../../src/sdk/wallet.ts";
import { logEvent } from "../game/log-store.ts";

export const GENESIS_SEED =
  "0000000000000000000000000000000000000000000000000000000000000001";

// The dev chain's genesis block mints NIGHT to the first few well-known seeds
// (…01, …02, …03 — "alice/bob/claire"). The faucet drains …01 over a long dev
// session, so funding falls through to the next seeded wallet.
const GENESIS_SEEDS = ["01", "02", "03"].map((n) => "00".repeat(31) + n);

// The genesis ("main") wallet — always available as the faucet's funding source,
// even after the active gas wallet has been swapped to a session wallet.
// The well-known genesis seed only holds funds on a local dev chain; building a
// wallet from it against a real network must never happen.
const genesisBySeed = new Map<string, Promise<WalletBundle>>();
function genesisWalletForSeed(seed: string): Promise<WalletBundle> {
  if (!IS_UNDEPLOYED) {
    return Promise.reject(
      new Error(`the genesis dev wallet is undeployed-only (network is "${NETWORK_ID}") — connect a browser wallet instead`),
    );
  }
  let p = genesisBySeed.get(seed);
  if (!p) {
    logEvent(`wallet: bringing up the genesis (…${seed.slice(-2)}) wallet…`);
    p = buildAndFundWallet(NETWORK, seed).then((b) => {
      logEvent(`wallet: genesis …${seed.slice(-2)} wallet ready (${b.unshieldedAddress.slice(0, 20)}…)`);
      return b;
    });
    genesisBySeed.set(seed, p);
  }
  return p;
}

export function getGenesisWallet(): Promise<WalletBundle> {
  return genesisWalletForSeed(GENESIS_SEED);
}

// The first genesis-funded dev wallet holding at least `minUnshielded` NIGHT —
// the faucet's funding source. Falls through …01 → …02 → …03 as earlier
// transfers drain them; only builds the next wallet when the previous is short.
export async function getGenesisWalletWithFunds(minUnshielded: bigint): Promise<WalletBundle> {
  for (const seed of GENESIS_SEEDS) {
    const bundle = await genesisWalletForSeed(seed);
    const funds = await waitForFunds(bundle, { requireShielded: false });
    if (funds.unshielded >= minUnshielded) return bundle;
    logEvent(`faucet: genesis …${seed.slice(-2)} has only ${funds.unshielded} NIGHT — trying the next dev seed`);
  }
  throw new Error(
    "all genesis dev seeds are out of NIGHT — restart the dev chain (bun run stack:down && bun run stack:up) to re-mint",
  );
}

// The active gas wallet — defaults to genesis; the faucet points it at a session
// wallet via setGasWallet. Heavy first call (~30s sync).
let active: Promise<WalletBundle> | null = null;
export function getGasWallet(): Promise<WalletBundle> {
  if (!active) active = getGenesisWallet();
  return active;
}

// Replace the active gas wallet (the faucet calls this once a session wallet is
// funded). Subsequent on-chain actions then pay from `bundle`.
export function setGasWallet(bundle: WalletBundle): void {
  active = Promise.resolve(bundle);
}
