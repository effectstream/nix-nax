// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

// Minimal Midnight DApp-connector surface — typed locally so we don't pull the
// full @midnight-ntwrk/dapp-connector-api package. A wallet extension injects
// itself at `window.midnight[rdns]`; calling `connect(networkId)` yields a
// ConnectedAPI we use to read dust + balance/submit player transactions.
// Mirrors midnight-ref-ai/midnight-wallet-dapp (useWalletDetection.ts + api.ts).

export interface ConnectedAPI {
  getConfiguration(): Promise<{
    indexerUri: string;
    indexerWsUri: string;
    proverServerUri?: string;
    substrateNodeUri: string;
    networkId: string;
  }>;
  getDustBalance(): Promise<{ cap: bigint; balance: bigint }>;
  // Shielded balances by raw token type (official dapp-connector-api surface) —
  // lets us read the win-token count from a connected extension wallet.
  getShieldedBalances(): Promise<Record<string, bigint>>;
  getDustAddress(): Promise<{ dustAddress: string }>;
  getUnshieldedAddress(): Promise<{ unshieldedAddress: string }>;
  getShieldedAddresses(): Promise<{
    shieldedAddress: string;
    shieldedCoinPublicKey: string;
    shieldedEncryptionPublicKey: string;
  }>;
  // Balance an externally-built (relay-proven, dust-less) tx — the wallet adds
  // its own dust as the fee when payFees is true — then submit it.
  balanceUnsealedTransaction(txHex: string, options?: { payFees?: boolean }): Promise<{ tx: string }>;
  submitTransaction(txHex: string): Promise<void>;
}

export interface InitialAPI {
  rdns: string;
  name: string;
  icon: string;
  apiVersion: string;
  connect(networkId: string): Promise<ConnectedAPI>;
}

type MidnightWindow = Window & { midnight?: Record<string, InitialAPI> };

export function listWallets(): InitialAPI[] {
  const m = (window as MidnightWindow).midnight;
  if (!m) return [];
  return Object.values(m).filter(
    (a): a is InitialAPI =>
      !!a && typeof a === "object" && typeof a.name === "string" && typeof a.connect === "function",
  );
}

export const hasWalletExtension = (): boolean => listWallets().length > 0;

export function connectWallet(api: InitialAPI, networkId: string): Promise<ConnectedAPI> {
  return api.connect(networkId);
}
