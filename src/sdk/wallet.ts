// Wallet bring-up for the local Midnight stack.
//
// Trimmed adaptation of pe-bun-3's packages/chains/midnight-contracts/src/{build-wallet,get-wallet-info}.ts —
// only what we need for an undeployed-network e2e:
//   * Build a WalletFacade from a seed.
//   * Wait for sync.
//   * Register Night UTXOs for dust generation so we can pay tx fees.
//   * Read shielded/unshielded/dust balances.
//
// Skipped: dust-state on-disk caching, dust-only sync mode, retry loops —
// those matter on slow remote networks, not on a fresh local stack.

import { Buffer } from "node:buffer";
import * as Rx from "rxjs";

import {
  ZswapSecretKeys,
  DustSecretKey,
  LedgerParameters,
  shieldedToken,
  type UnprovenTransaction,
} from "@midnight-ntwrk/ledger-v8";
import { HDWallet, Roles } from "@midnight-ntwrk/wallet-sdk-hd";
import { WalletFacade, type DefaultConfiguration } from "@midnight-ntwrk/wallet-sdk-facade";
import { ShieldedWallet } from "@midnight-ntwrk/wallet-sdk-shielded";
import { DustWallet } from "@midnight-ntwrk/wallet-sdk-dust-wallet";
import {
  UnshieldedWallet,
  createKeystore,
  PublicKey,
  type UnshieldedKeystore,
} from "@midnight-ntwrk/wallet-sdk-unshielded-wallet";
// NoOp/InMemory history storage moved to wallet-sdk-abstractions in the 1.2.0 set.
import { NetworkId, NoOpTransactionHistoryStorage } from "@midnight-ntwrk/wallet-sdk-abstractions";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";

import { CONSTANTS, type NetworkUrls } from "./env.ts";

export interface WalletBundle {
  wallet: WalletFacade;
  zswapSecretKeys: ZswapSecretKeys;
  dustSecretKey: DustSecretKey;
  dustAddress: string;
  unshieldedAddress: string;
  unshieldedKeystore: UnshieldedKeystore;
}

const log = console;

function deriveSeedForRole(seed: string, role: any): Uint8Array {
  const result = HDWallet.fromSeed(Buffer.from(seed, "hex"));
  if (result.type !== "seedOk") throw new Error(`HD wallet seed bad: ${result.type}`);
  const derived = result.hdWallet.selectAccount(0).selectRole(role).deriveKeyAt(0);
  if (derived.type === "keyOutOfBounds") throw new Error(`derive out of bounds for role ${String(role)}`);
  return Buffer.from(derived.key);
}

function walletConfig(urls: NetworkUrls): DefaultConfiguration {
  return {
    indexerClientConnection: {
      indexerHttpUrl: urls.indexer,
      indexerWsUrl: urls.indexerWS,
    },
    provingServerUrl: new URL(urls.proofServer),
    relayURL: new URL(urls.node.replace("http", "ws")),
    networkId: urls.networkId,
    // We never read tx history here (deploy/faucet only need balances + submit).
    // NoOp avoids storing/replaying history, which has been observed to make
    // initial wallet sync more reliable than the in-memory store.
    txHistoryStorage: new NoOpTransactionHistoryStorage(),
    costParameters: {
      additionalFeeOverhead: CONSTANTS.DUST_FEE_OVERHEAD,
      feeBlocksMargin: CONSTANTS.DUST_FEE_BLOCKS_MARGIN,
    },
  } as any;
}

export async function buildWallet(urls: NetworkUrls, seed: string): Promise<WalletBundle> {
  setNetworkId(urls.networkId);
  log.info(`Building wallet (networkId=${urls.networkId}, seed=${seed.slice(0, 10)}…)`);

  const shieldedSeed = deriveSeedForRole(seed, Roles.Zswap);
  const dustSeed = deriveSeedForRole(seed, Roles.Dust);
  const unshieldedSeed = deriveSeedForRole(seed, Roles.NightExternal);

  const config = walletConfig(urls);
  const unshieldedKeystore = createKeystore(unshieldedSeed, urls.networkId);

  const shielded = ShieldedWallet(config as any).startWithSeed(shieldedSeed);
  const dustParams = LedgerParameters.initialParameters();
  const dustCfg: any = { ...config, costParameters: { ledgerParams: dustParams, additionalFeeOverhead: CONSTANTS.DUST_FEE_OVERHEAD, feeBlocksMargin: CONSTANTS.DUST_FEE_BLOCKS_MARGIN } };
  const dust = DustWallet(dustCfg).startWithSeed(dustSeed, dustParams.dust);
  const unshielded = UnshieldedWallet({ ...config, txHistoryStorage: new NoOpTransactionHistoryStorage() } as any)
    .startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore));

  const zswapSecretKeys = ZswapSecretKeys.fromSeed(shieldedSeed);
  const dustSecretKey = DustSecretKey.fromSeed(dustSeed);

  const wallet: WalletFacade = await WalletFacade.init({
    configuration: config as any,
    shielded: () => shielded,
    unshielded: () => unshielded,
    dust: () => dust,
  });
  await wallet.start(zswapSecretKeys, dustSecretKey);

  const unshieldedAddress = unshieldedKeystore.getBech32Address().asString();
  // The dust-wallet returns a typed DustAddress object — exposing the bech32
  // string varies across SDK versions, so we use `.toString()` as a best-effort
  // human-readable label. (Not used in any transaction; logging only.)
  const initialDust = (await Rx.firstValueFrom((wallet.dust as any).state)) as any;
  const dustAddress = String((initialDust?.address?.asString?.() ?? initialDust?.address ?? ""));

  return { wallet, zswapSecretKeys, dustSecretKey, dustAddress, unshieldedAddress, unshieldedKeystore };
}

export async function waitForFunds(
  bundle: WalletBundle,
  opts: { timeoutMs?: number; requireShielded?: boolean } = {}
): Promise<{ shielded: bigint; unshielded: bigint; dust: bigint }> {
  const timeoutMs = opts.timeoutMs ?? CONSTANTS.WALLET_SYNC_TIMEOUT_MS;
  const requireShielded = opts.requireShielded ?? true;
  const start = Date.now();

  const state = await Rx.firstValueFrom(
    bundle.wallet.state().pipe(
      Rx.throttleTime(CONSTANTS.WALLET_SYNC_THROTTLE_MS),
      Rx.tap((s: any) => {
        const sh = s.shielded.state.progress.isStrictlyComplete();
        const ds = s.dust.state.progress.isStrictlyComplete();
        const un = s.unshielded?.progress?.isStrictlyComplete() ?? false;
        log.info(`[wallet sync ${((Date.now() - start) / 1000).toFixed(0)}s] shielded=${sh} unshielded=${un} dust=${ds}`);
      }),
      Rx.filter((s: any) => {
        const sh = s.shielded.state.progress.isStrictlyComplete();
        const ds = s.dust.state.progress.isStrictlyComplete();
        const un = s.unshielded?.progress?.isStrictlyComplete() ?? false;
        if (!sh || !ds || !un) return false;
        if (requireShielded) {
          const bal = s.shielded.balances?.[shieldedToken().tag] ?? 0n;
          return bal > 0n;
        }
        return true;
      }),
      Rx.timeout({ each: timeoutMs, with: () => Rx.throwError(() => new Error(`wallet sync timeout after ${timeoutMs}ms`)) })
    )
  );

  const shielded = (state as any).shielded.balances?.[shieldedToken().tag] ?? 0n;
  const unshielded = Object.values(((state as any).unshielded?.balances ?? {}) as Record<string, bigint>)
    .reduce((acc, v) => acc + (v ?? 0n), 0n);
  let dust = 0n;
  try {
    const now = new Date();
    dust = (state as any).dust?.walletBalance?.(now) ?? (state as any).dust?.balance?.(now) ?? 0n;
  } catch {}
  return { shielded, unshielded, dust };
}

// Registers any unregistered unshielded Night UTXOs for dust generation, so
// the wallet can pay transaction fees. Returns true if it submitted a tx.
export async function registerNightForDust(bundle: WalletBundle): Promise<boolean> {
  log.info("Checking unshielded Night UTXOs for dust registration…");
  const state = await Rx.firstValueFrom(
    bundle.wallet.state().pipe(
      Rx.filter((s: any) =>
        (s.dust?.state?.progress?.isStrictlyComplete() ?? false) &&
        (s.unshielded?.progress?.isStrictlyComplete() ?? false)
      ),
      Rx.timeout({ each: CONSTANTS.WALLET_SYNC_TIMEOUT_MS, with: () => Rx.throwError(() => new Error("dust precheck sync timeout")) }),
    )
  );
  const unregistered: any[] =
    (state as any).unshielded?.availableCoins?.filter((c: any) => c.meta.registeredForDustGeneration === false) ?? [];
  if (unregistered.length === 0) {
    log.info("No unregistered Night UTXOs.");
    return false;
  }
  log.info(`Registering ${unregistered.length} Night UTXOs for dust…`);
  const recipe = await (bundle.wallet as any).registerNightUtxosForDustGeneration(
    unregistered,
    bundle.unshieldedKeystore.getPublicKey(),
    (payload: Uint8Array) => bundle.unshieldedKeystore.signData(payload),
  );
  // Signing already happened INSIDE registerNightUtxosForDustGeneration (the 3rd
  // arg) — just finalize the recipe and submit. NO extra signRecipe /
  // signUnprovenTransaction step (those re-signed/bypassed the recipe and the
  // chain rejected the tx as invalid, 1010 / Custom error 192). Matches the
  // canonical effectstream-a get-wallet-info.ts registerNightForDust.
  const txId = await bundle.wallet.submitTransaction(
    await (bundle.wallet as any).finalizeRecipe(recipe),
  );
  log.info(`Dust registration tx submitted: ${txId}`);

  // Wait for dust to appear.
  await Rx.firstValueFrom(
    bundle.wallet.state().pipe(
      Rx.throttleTime(CONSTANTS.WALLET_SYNC_THROTTLE_MS),
      Rx.filter((s: any) => {
        const now = new Date();
        const d = s.dust?.walletBalance?.(now) ?? s.dust?.balance?.(now) ?? 0n;
        return (d as bigint) > 0n;
      }),
      Rx.timeout({ each: CONSTANTS.WALLET_SYNC_TIMEOUT_MS, with: () => Rx.throwError(() => new Error("dust generation timeout")) })
    )
  );
  log.info("Dust generation confirmed.");
  return true;
}

// Convenience: build wallet, wait for funds, register dust if necessary,
// returning the funded bundle ready for transactions.
export async function buildAndFundWallet(urls: NetworkUrls, seed: string): Promise<WalletBundle> {
  const bundle = await buildWallet(urls, seed);
  const shieldedState = (await Rx.firstValueFrom((bundle.wallet.shielded as any).state)) as any;
  log.info(`Wallet shielded address: ${shieldedState.address.coinPublicKeyString()}`);
  log.info(`Wallet dust address:     ${bundle.dustAddress}`);
  log.info(`Wallet unshielded:       ${bundle.unshieldedAddress}`);

  const funds = await waitForFunds(bundle, { requireShielded: false });
  log.info(`After initial sync: shielded=${funds.shielded} unshielded=${funds.unshielded} dust=${funds.dust}`);

  if (funds.dust === 0n && funds.unshielded > 0n) {
    await registerNightForDust(bundle);
  }
  return bundle;
}
