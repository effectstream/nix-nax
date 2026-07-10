// Browser provider set for client-side midnight-js contract calls. Mirrors
// src/sdk/providers.ts buildProviders, but swaps the Node ZK-config provider
// (filesystem) for the browser FetchZkConfigProvider (HTTP), reading the
// compiled assets the vite middleware serves. The wallet adapter is identical:
// balance via the in-browser WalletFacade + submit.

import { Buffer } from "buffer";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { levelPrivateStateProvider } from "@midnight-ntwrk/midnight-js-level-private-state-provider";
import { FetchZkConfigProvider } from "@midnight-ntwrk/midnight-js-fetch-zk-config-provider";
import type {
  CoinPublicKey,
  EncPublicKey,
  FinalizedTransaction,
  TransactionId,
} from "@midnight-ntwrk/ledger-v8";
import type {
  MidnightProvider,
  MidnightProviders,
  UnboundTransaction,
  WalletProvider,
} from "@midnight-ntwrk/midnight-js-types";

import { CONSTANTS } from "../../../src/sdk/env.ts";
import { NETWORK, STORAGE_PASSWORD, assertNetworkConfigured } from "./env.ts";
import type { WalletBundle } from "../../../src/sdk/wallet.ts";
import { ZK_ASSETS_BASE } from "./compiled.ts";

const ttl = () => new Date(Date.now() + CONSTANTS.TTL_DURATION_MS);

// Balance + submit a midnight-js tx with the in-browser WalletFacade (same shape
// as src/sdk/providers.ts walletAndMidnight — the wallet pays its own gas).
function walletAndMidnight(bundle: WalletBundle): WalletProvider & MidnightProvider {
  return {
    getCoinPublicKey(): CoinPublicKey {
      return bundle.zswapSecretKeys.coinPublicKey;
    },
    getEncryptionPublicKey(): EncPublicKey {
      return bundle.zswapSecretKeys.encryptionPublicKey;
    },
    async balanceTx(tx: UnboundTransaction, deadline?: Date): Promise<FinalizedTransaction> {
      const bound = tx.bind();
      const recipe = await bundle.wallet.balanceFinalizedTransaction(
        bound,
        { shieldedSecretKeys: bundle.zswapSecretKeys, dustSecretKey: bundle.dustSecretKey },
        { ttl: deadline ?? ttl() },
      );
      const signed = await bundle.wallet.signRecipe(
        recipe,
        (payload) => bundle.unshieldedKeystore.signData(payload),
      );
      return bundle.wallet.finalizeRecipe(signed);
    },
    submitTx(tx: FinalizedTransaction): Promise<TransactionId> {
      return bundle.wallet.submitTransaction(tx);
    },
  };
}

const ZK_BASE = window.location.origin + ZK_ASSETS_BASE;

export function buildBrowserProviders(opts: {
  wallet: WalletBundle;
  privateStateStoreName?: string;
  midnightDbName?: string;
}): MidnightProviders {
  assertNetworkConfigured();
  const adapter = walletAndMidnight(opts.wallet);
  const store = opts.privateStateStoreName ?? "ttt-arena";
  const zkConfigProvider = new FetchZkConfigProvider(ZK_BASE, fetch.bind(window));
  return {
    privateStateProvider: levelPrivateStateProvider({
      midnightDbName: opts.midnightDbName ?? "ttt-web-db",
      privateStateStoreName: store,
      signingKeyStoreName: `${store}-signing-keys`,
      privateStoragePasswordProvider: async () => STORAGE_PASSWORD,
      accountId: Buffer.from(opts.wallet.zswapSecretKeys.coinPublicKey).toString("hex"),
    } as any),
    publicDataProvider: indexerPublicDataProvider(NETWORK.indexer, NETWORK.indexerWS),
    zkConfigProvider: zkConfigProvider as any,
    proofProvider: httpClientProofProvider(NETWORK.proofServer, zkConfigProvider as any),
    walletProvider: adapter,
    midnightProvider: adapter,
  };
}
