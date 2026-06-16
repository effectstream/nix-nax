// In-browser wallets for the local `undeployed` network — they build, balance
// (pay dust), and submit the player's on-chain txs, replacing the relay's seed
// wallet. Two roles:
//   • genesis ("main") wallet — funded at genesis; the faucet's source.
//   • the active GAS wallet — what on-chain actions pay from. Defaults to genesis
//     (works single-tab); the faucet (faucet.ts) swaps in a funded session wallet.

import { NETWORK } from "../../../src/sdk/env.ts";
import { buildAndFundWallet, type WalletBundle } from "../../../src/sdk/wallet.ts";
import { logEvent } from "../game/log-store.ts";

export const GENESIS_SEED =
  "0000000000000000000000000000000000000000000000000000000000000001";

// The genesis ("main") wallet — always available as the faucet's funding source,
// even after the active gas wallet has been swapped to a session wallet.
let genesisP: Promise<WalletBundle> | null = null;
export function getGenesisWallet(): Promise<WalletBundle> {
  if (!genesisP) {
    logEvent("wallet: bringing up the genesis (main) wallet…");
    genesisP = buildAndFundWallet(NETWORK, GENESIS_SEED).then((b) => {
      logEvent(`wallet: genesis wallet ready (${b.unshieldedAddress.slice(0, 20)}…)`);
      return b;
    });
  }
  return genesisP;
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
