// Browser faucet (undeployed dev). Moves NIGHT from the genesis "main" wallet to
// a fresh, persisted session wallet, then registers that NIGHT for dust
// generation and makes the session wallet the active gas wallet — so each
// browser pays its own gas instead of using the genesis wallet directly.
// Mirrors the transfer API in midnight-ref-ai/.../faucet/FaucetImpl.ts.

import { firstValueFrom } from "rxjs";
import { unshieldedToken } from "@midnight-ntwrk/ledger-v8";
import { MidnightBech32m, UnshieldedAddress } from "@midnight-ntwrk/wallet-sdk-address-format";
import { NETWORK, NETWORK_ID, IS_UNDEPLOYED } from "../chain/env.ts";
import { buildWallet, waitForFunds, registerNightForDust, type WalletBundle } from "../../../src/sdk/wallet.ts";
import { getGenesisWallet, setGasWallet } from "./local-wallet.ts";
import { resetArena } from "../chain/arena.ts";
import { logEvent } from "../game/log-store.ts";

const SESSION_SEED_KEY = "nixnax:session-wallet-seed";
// The session wallet mints NIGHT from the local genesis seed, which only exists on
// the `undeployed` dev chain — so it must never be offered on a real network.
export const sessionWalletAvailable = IS_UNDEPLOYED;
const FUND_AMOUNT = 50_000_000_000_000n; // NIGHT moved genesis → session
const ttl = () => new Date(Date.now() + 30 * 60 * 1000);

// A stable per-browser session seed so the session wallet (and its on-chain
// NIGHT/dust) survives reloads.
function sessionSeed(): string {
  let s = localStorage.getItem(SESSION_SEED_KEY);
  if (!s) {
    const b = crypto.getRandomValues(new Uint8Array(32));
    s = Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
    localStorage.setItem(SESSION_SEED_KEY, s);
  }
  return s;
}

let sessionP: Promise<WalletBundle> | null = null;
export function getSessionWallet(): Promise<WalletBundle> {
  if (!sessionP) sessionP = buildWallet(NETWORK, sessionSeed());
  return sessionP;
}

export interface FaucetResult {
  address: string;
  unshielded: bigint;
  dust: bigint;
  alreadyFunded: boolean;
}

// Fund a CONNECTED EXTERNAL wallet (e.g. Lace) on the local dev chain: decode
// its bech32 unshielded address and transfer NIGHT from the genesis wallet.
// Undeployed-only — genesis holds no funds on real networks. Dust generation
// happens wallet-side: the extension registers its own NIGHT UTXOs (we can't —
// registration must be signed by the receiving wallet's keys).
export async function fundConnectedWallet(
  bech32Address: string,
  log: (s: string) => void = logEvent,
): Promise<{ txHash: string; amount: bigint }> {
  if (!IS_UNDEPLOYED) {
    throw new Error(`the dev faucet is undeployed-only (network is "${NETWORK_ID}") — use the ${NETWORK_ID} network faucet to fund your wallet`);
  }
  const receiverAddress = MidnightBech32m.parse(bech32Address).decode(
    UnshieldedAddress as any,
    NETWORK.networkId as any,
  );
  const main = await getGenesisWallet();
  log(`faucet: transferring ${FUND_AMOUNT} NIGHT from genesis → ${bech32Address.slice(0, 20)}…`);
  const transfer = [{
    type: "unshielded",
    outputs: [{ amount: FUND_AMOUNT, receiverAddress, type: unshieldedToken().raw }],
  }];
  const recipe = await (main.wallet as any).transferTransaction(
    transfer,
    { shieldedSecretKeys: main.zswapSecretKeys, dustSecretKey: main.dustSecretKey },
    { ttl: ttl() },
  );
  const signed = await main.wallet.signRecipe(recipe, (p) => main.unshieldedKeystore.signData(p));
  const finalized = await main.wallet.finalizeRecipe(signed);
  const txHash = String(await main.wallet.submitTransaction(finalized));
  log(`faucet: ✅ transfer tx ${txHash.slice(0, 16)}… — NIGHT will appear in your wallet shortly. Register it for dust (gas) from your wallet's own UI.`);
  return { txHash, amount: FUND_AMOUNT };
}

// Fund the session wallet (if needed), register it for dust, and activate it as
// the gas wallet. Idempotent: re-running once funded just re-activates it.
export async function runFaucet(log: (s: string) => void = logEvent): Promise<FaucetResult> {
  if (!sessionWalletAvailable) {
    throw new Error(`session wallet / auto-faucet is undeployed-only (network is "${NETWORK_ID}")`);
  }
  const session = await getSessionWallet();
  log(`faucet: session wallet ${session.unshieldedAddress.slice(0, 24)}…`);
  let funds = await waitForFunds(session, { requireShielded: false });
  log(`faucet: session initial funds — unshielded=${funds.unshielded} dust=${funds.dust}`);

  if (funds.dust > 0n) {
    setGasWallet(session);
    resetArena();
    log("faucet: session already funded + generating dust — set as gas wallet");
    return { address: session.unshieldedAddress, unshielded: funds.unshielded, dust: funds.dust, alreadyFunded: true };
  }

  if (funds.unshielded === 0n) {
    const main = await getGenesisWallet();
    log(`faucet: transferring ${FUND_AMOUNT} NIGHT from genesis → session…`);
    // The session wallet is in this browser, so use its own unshielded address
    // object from wallet state (same form the SDK uses for self-outputs) rather
    // than decoding a bech32 string — this version's address-format has no
    // UnshieldedAddress codec.
    const sstate: any = await firstValueFrom((session.wallet as any).state());
    const receiverAddress = sstate.unshielded.address;
    const transfer = [{
      type: "unshielded",
      outputs: [{ amount: FUND_AMOUNT, receiverAddress, type: unshieldedToken().raw }],
    }];
    const recipe = await (main.wallet as any).transferTransaction(
      transfer,
      { shieldedSecretKeys: main.zswapSecretKeys, dustSecretKey: main.dustSecretKey },
      { ttl: ttl() },
    );
    const signed = await main.wallet.signRecipe(recipe, (p) => main.unshieldedKeystore.signData(p));
    const finalized = await main.wallet.finalizeRecipe(signed);
    const hash = await main.wallet.submitTransaction(finalized);
    log(`faucet: transfer tx ${String(hash).slice(0, 16)}… — waiting for session to receive NIGHT…`);
    // waitForFunds returns once sync-progress is complete, which happens BEFORE
    // the transfer is included in a block — so poll until the NIGHT actually
    // lands. Registering before the UTXO confirms causes "Invalid Transaction".
    for (let i = 0; i < 40 && funds.unshielded === 0n; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      funds = await waitForFunds(session, { requireShielded: false });
    }
    if (funds.unshielded === 0n) throw new Error("session never received the transferred NIGHT (timeout)");
    log(`faucet: session received unshielded=${funds.unshielded}`);
  }

  log("faucet: registering session NIGHT for dust generation…");
  try {
    await registerNightForDust(session);
  } catch (e) {
    // Known Midnight constraint on undeployed: a fresh wallet holding NIGHT but
    // no dust can't submit its own dust-registration tx (chain rejects with
    // "1010 Invalid Transaction: Custom error 192"). Don't break the app — leave
    // the genesis wallet (which has dust) as the gas payer.
    log(`faucet: ⚠️ dust registration rejected (${(e as Error).message}); the session has NIGHT but no dust — keeping the genesis wallet as gas payer`);
    return { address: session.unshieldedAddress, unshielded: funds.unshielded, dust: 0n, alreadyFunded: false };
  }
  setGasWallet(session);
  resetArena();
  funds = await waitForFunds(session, { requireShielded: false });
  log(`faucet: ✅ session ready — dust ${funds.dust}; now the gas wallet`);
  return { address: session.unshieldedAddress, unshielded: funds.unshielded, dust: funds.dust, alreadyFunded: false };
}
