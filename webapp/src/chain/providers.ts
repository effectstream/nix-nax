// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

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
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import type { ConnectedAPI } from "../wallet/connector.ts";
import { createConnectorWalletProviders } from "../wallet/connector-adapter.ts";

const ttl = () => new Date(Date.now() + CONSTANTS.TTL_DURATION_MS);

// Balance + submit a midnight-js tx with the in-browser WalletFacade (same shape
// as src/sdk/providers.ts walletAndMidnight — the wallet pays its own gas).
function walletAndMidnight(
  bundle: WalletBundle,
  assertCurrent: () => void,
): WalletProvider & MidnightProvider {
  return {
    getCoinPublicKey(): CoinPublicKey {
      assertCurrent();
      return bundle.zswapSecretKeys.coinPublicKey;
    },
    getEncryptionPublicKey(): EncPublicKey {
      assertCurrent();
      return bundle.zswapSecretKeys.encryptionPublicKey;
    },
    async balanceTx(tx: UnboundTransaction, deadline?: Date): Promise<FinalizedTransaction> {
      assertCurrent();
      const bound = tx.bind();
      const recipe = await bundle.wallet.balanceFinalizedTransaction(
        bound,
        { shieldedSecretKeys: bundle.zswapSecretKeys, dustSecretKey: bundle.dustSecretKey },
        { ttl: deadline ?? ttl() },
      );
      assertCurrent();
      const signed = await bundle.wallet.signRecipe(
        recipe,
        (payload) => bundle.unshieldedKeystore.signData(payload),
      );
      assertCurrent();
      const finalized = await bundle.wallet.finalizeRecipe(signed);
      assertCurrent();
      return finalized;
    },
    async submitTx(tx: FinalizedTransaction): Promise<TransactionId> {
      assertCurrent();
      const result = await bundle.wallet.submitTransaction(tx);
      // Submission may already have reached the node. This guard prevents a
      // stale success path; callers must reconcile an uncertain outcome.
      assertCurrent();
      return result;
    },
  };
}

const ZK_BASE = window.location.origin + ZK_ASSETS_BASE;

export function buildBrowserProviders(opts: {
  wallet: WalletBundle;
  privateStateStoreName?: string;
  midnightDbName?: string;
  assertCurrent?: () => void;
}): MidnightProviders {
  assertNetworkConfigured();
  const adapter = walletAndMidnight(opts.wallet, opts.assertCurrent ?? (() => {}));
  const store = opts.privateStateStoreName ?? "nixnax-arena";
  const zkConfigProvider = new FetchZkConfigProvider(ZK_BASE, fetch.bind(window));
  return {
    privateStateProvider: levelPrivateStateProvider({
      midnightDbName: opts.midnightDbName ?? "nixnax-web-db",
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

// Provider set backed by a connected DApp-connector wallet (e.g. Lace). Mirrors
// the reference midnight-wallet-dapp buildProvidersFromConnectedAPI: read the
// wallet's own config (endpoints) + shielded address, wrap it into a
// wallet/midnight provider, and let the normal `found.callTx.*` flow run — the
// proof server proves, the wallet balances the dust + signs + submits.
export async function buildConnectorProviders(opts: {
  api: ConnectedAPI;
  privateStateStoreName?: string;
  midnightDbName?: string;
  initialSecret?: Uint8Array;
  assertCurrent?: () => void;
}): Promise<MidnightProviders> {
  assertNetworkConfigured();
  const config = await opts.api.getConfiguration();
  // The local-wallet path sets this inside buildWallet(); the connector path
  // builds no SDK wallet, so set it here from the wallet's own network before
  // any contract op (else: "Network ID has not been configured").
  setNetworkId(config.networkId as any);
  const sh = await opts.api.getShieldedAddresses();
  const store = opts.privateStateStoreName ?? "nixnax-arena-connector";
  const zkConfigProvider = new FetchZkConfigProvider(ZK_BASE, fetch.bind(window));
  const { walletProvider, midnightProvider } = createConnectorWalletProviders(
    opts.api,
    sh.shieldedCoinPublicKey,
    sh.shieldedEncryptionPublicKey,
    opts.assertCurrent,
  );
  // Use the wallet's own endpoints so the dApp and wallet agree on the network;
  // fall back to our build-time proof server if the wallet doesn't host one.
  const rawPublicDataProvider = indexerPublicDataProvider(config.indexerUri, config.indexerWsUri);
  const publicDataProvider = {
    ...rawPublicDataProvider,
    async queryZSwapAndContractState(contractAddress: any, queryConfig?: any) {
      const result = await (rawPublicDataProvider as any).queryZSwapAndContractState(contractAddress, queryConfig);
      if (!result) return result;
      const [zswapChainState, contractState, ledgerParameters] = result;
      return [zswapChainState.postBlockUpdate(new Date()), contractState, ledgerParameters];
    },
  };
  return {
    privateStateProvider: levelPrivateStateProvider({
      midnightDbName: opts.midnightDbName ?? "nixnax-web-db-connector",
      privateStateStoreName: store,
      signingKeyStoreName: `${store}-signing-keys`,
      privateStoragePasswordProvider: async () => STORAGE_PASSWORD,
      accountId: sh.shieldedAddress,
    } as any),
    publicDataProvider: publicDataProvider as any,
    zkConfigProvider: zkConfigProvider as any,
    // The WALLET's configured proof server is authoritative — the prover sees
    // private witness data, so a dApp that could steer proving to its own URL
    // would be an exfiltration vector. Users pick their prover in the wallet
    // (e.g. Lace settings → localhost:6300 for a self-hosted one). Our VITE_
    // value is only the fallback for wallets that don't supply one.
    proofProvider: httpClientProofProvider(config.proverServerUri || NETWORK.proofServer, zkConfigProvider as any),
    walletProvider,
    midnightProvider,
  };
}

// Public contract state does not require a wallet, proving keys, or a private
// state store. Keeping this read path separate lets the lobby inspect saved games
// before the player chooses a transaction wallet.
export function buildPublicDataProvider(): ReturnType<typeof indexerPublicDataProvider> {
  assertNetworkConfigured();
  return indexerPublicDataProvider(NETWORK.indexer, NETWORK.indexerWS);
}
