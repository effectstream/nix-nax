// Builds the 6-provider bundle that midnight-js needs.
// Mirrors pe-bun-3's packages/chains/midnight-contracts/src/providers.ts.

import { Buffer } from "node:buffer";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { levelPrivateStateProvider } from "@midnight-ntwrk/midnight-js-level-private-state-provider";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
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

import { CONSTANTS } from "./env.ts";
import type { WalletBundle } from "./wallet.ts";

const ttl = () => new Date(Date.now() + CONSTANTS.TTL_DURATION_MS);

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

export function buildProviders(opts: {
  wallet: WalletBundle;
  zkConfigPath: string;
  privateStateStoreName: string;
  networkUrls: { indexer: string; indexerWS: string; proofServer: string };
  midnightDbName?: string;
}): MidnightProviders {
  const adapter = walletAndMidnight(opts.wallet);
  const zkConfigProvider = new NodeZkConfigProvider(opts.zkConfigPath);
  return {
    privateStateProvider: levelPrivateStateProvider({
      midnightDbName: opts.midnightDbName ?? "nixnax-level-db",
      privateStateStoreName: opts.privateStateStoreName,
      signingKeyStoreName: `${opts.privateStateStoreName}-signing-keys`,
      privateStoragePasswordProvider: async () => CONSTANTS.STORAGE_PASSWORD,
      accountId: Buffer.from(opts.wallet.zswapSecretKeys.coinPublicKey).toString("hex"),
    } as any),
    publicDataProvider: indexerPublicDataProvider(opts.networkUrls.indexer, opts.networkUrls.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(opts.networkUrls.proofServer, zkConfigProvider),
    walletProvider: adapter,
    midnightProvider: adapter,
  };
}
