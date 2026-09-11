// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

// Adapt a Midnight DApp-connector wallet (e.g. Lace) into midnight-js
// WalletProvider + MidnightProvider, so the normal `found.callTx.*` flow runs
// through the extension: the browser proves the tx, then the wallet balances
// the dust + signs (balanceUnsealedTransaction) and submits it
// (submitTransaction). Faithful port of the reference midnight-wallet-dapp
// src/lib/walletAdapter.ts (createWalletProvidersFromConnectedAPI).

import { Transaction } from "@midnight-ntwrk/ledger-v8";
import type {
  CoinPublicKey,
  EncPublicKey,
  FinalizedTransaction,
} from "@midnight-ntwrk/ledger-v8";
import type { MidnightProvider, UnboundTransaction, WalletProvider } from "@midnight-ntwrk/midnight-js-types";
import type { ConnectedAPI } from "./connector.ts";
import { logEvent } from "../game/log-store.ts";

const toHex = (b: Uint8Array): string =>
  Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (hex: string): Uint8Array => {
  const cleaned = hex.replace(/^0x/, "");
  const m = cleaned.match(/.{1,2}/g);
  return m ? new Uint8Array(m.map((byte) => parseInt(byte, 16))) : new Uint8Array();
};

export function createConnectorWalletProviders(
  api: ConnectedAPI,
  shieldedCoinPublicKey: string,
  shieldedEncryptionPublicKey: string,
  assertCurrent: () => void = () => {},
): { walletProvider: WalletProvider; midnightProvider: MidnightProvider } {
  const walletProvider: WalletProvider = {
    getCoinPublicKey: () => {
      assertCurrent();
      return shieldedCoinPublicKey as unknown as CoinPublicKey;
    },
    getEncryptionPublicKey: () => {
      assertCurrent();
      return shieldedEncryptionPublicKey as unknown as EncPublicKey;
    },
    async balanceTx(tx: UnboundTransaction): Promise<FinalizedTransaction> {
      assertCurrent();
      // Serialize the proven-but-unbalanced tx to hex → wallet balances the dust
      // fee + signs → deserialize the returned balanced tx.
      const hex = toHex((tx as any).serialize());
      logEvent("wallet: balancing tx (approve in your wallet)…");
      const { tx: balanced } = await api.balanceUnsealedTransaction(hex);
      assertCurrent();
      return Transaction.deserialize("signature", "proof", "binding", fromHex(balanced)) as unknown as FinalizedTransaction;
    },
  };

  const midnightProvider: MidnightProvider = {
    async submitTx(tx: FinalizedTransaction): Promise<any> {
      assertCurrent();
      await api.submitTransaction(toHex((tx as any).serialize()));
      // The call above may already have handed the transaction to the network;
      // this final guard prevents stale UI success but cannot retract submission.
      assertCurrent();
      // The wallet submitTransaction returns void; derive the id locally.
      return (tx as any).identifiers?.()?.[0] ?? "";
    },
  };

  return { walletProvider, midnightProvider };
}
