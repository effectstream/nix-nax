// The in-browser gas wallet for the local `undeployed` network — it builds,
// balances (pays dust), and submits the player's on-chain txs, replacing the
// relay's seed wallet. For now this is the genesis wallet directly; the faucet
// (faucet.ts) will later mint a session wallet, fund it from genesis, and point
// `getGasWallet()` at it so each browser pays from its own wallet.

import { NETWORK } from "../../../src/sdk/env.ts";
import { buildAndFundWallet, type WalletBundle } from "../../../src/sdk/wallet.ts";
import { logEvent } from "../game/log-store.ts";

export const GENESIS_SEED =
  "0000000000000000000000000000000000000000000000000000000000000001";

let active: Promise<WalletBundle> | null = null;

// Build + fund the gas wallet once (cached). Heavy first call (~30s sync).
export function getGasWallet(): Promise<WalletBundle> {
  if (!active) {
    logEvent("wallet: bringing up the in-browser gas wallet…");
    active = buildAndFundWallet(NETWORK, GENESIS_SEED).then((b) => {
      logEvent(`wallet: gas wallet ready (${b.unshieldedAddress.slice(0, 20)}…)`);
      return b;
    });
  }
  return active;
}

// Replace the active gas wallet (used by the faucet once a session wallet is
// funded). Subsequent on-chain actions then pay from `bundle`.
export function setGasWallet(bundle: WalletBundle): void {
  active = Promise.resolve(bundle);
}
