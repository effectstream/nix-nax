// Connected-wallet store + React hook. A module-level store (so the dual-mode
// Submitter and the UI share one connection) plus useSyncExternalStore.

import { useSyncExternalStore } from "react";
import { listWallets, connectWallet, hasWalletExtension, type ConnectedAPI, type InitialAPI } from "./connector.ts";
import { logEvent } from "../game/log-store.ts";

// The dev stack runs the "undeployed" network; testnet/real envs override via
// VITE_NETWORK_ID. The wallet must be set to this network to connect.
export const NETWORK_ID = (import.meta as { env?: Record<string, string> }).env?.VITE_NETWORK_ID ?? "undeployed";

// "wallet" = a connected browser extension pays its own gas; "local" = the dev
// "Local wallet" where the relay's seed wallet pays (undeployed only).
export type WalletMode = "wallet" | "local";

export interface WalletState {
  mode: WalletMode | null;
  api: ConnectedAPI | null;
  name: string | null;
  address: string | null;
  dust: { cap: bigint; balance: bigint } | null;
  connecting: boolean;
}

let state: WalletState = { mode: null, api: null, name: null, address: null, dust: null, connecting: false };
const subs = new Set<() => void>();
const set = (next: Partial<WalletState>) => { state = { ...state, ...next }; for (const f of subs) f(); };

export const walletApi = (): ConnectedAPI | null => state.api;

// Connect a specific browser-extension wallet → it pays the player's gas.
export async function connect(wallet: InitialAPI): Promise<void> {
  set({ connecting: true });
  try {
    const api = await connectWallet(wallet, NETWORK_ID);
    const [addr, dust] = await Promise.all([
      api.getUnshieldedAddress().catch(() => null),
      api.getDustBalance().catch(() => null),
    ]);
    set({ mode: "wallet", api, name: wallet.name, address: addr?.unshieldedAddress ?? null, dust, connecting: false });
    logEvent(`wallet: connected ${wallet.name}${dust ? ` — dust ${dust.balance}/${dust.cap}` : ""}`);
    if (dust && dust.balance === 0n) logEvent("⚠️ wallet has 0 dust — fund it to pay for gas");
  } catch (e) {
    set({ connecting: false });
    logEvent(`! wallet connect failed: ${(e as Error).message}`);
  }
}

// "Local wallet" (undeployed dev): no extension — the relay's seed wallet pays
// gas. `api` stays null so the dual-mode Submitter keeps using the relay path.
export function connectLocal(): void {
  set({ mode: "local", api: null, name: "Local wallet", address: null, dust: null, connecting: false });
  logEvent("wallet: using the local wallet — the relay pays gas");
}

export function disconnect(): void {
  set({ mode: null, api: null, name: null, address: null, dust: null });
  logEvent("wallet: disconnected — the relay will pay gas");
}

export function useWallet(): WalletState {
  return useSyncExternalStore(
    (cb) => { subs.add(cb); return () => subs.delete(cb); },
    () => state,
  );
}

export { hasWalletExtension, listWallets };
export type { InitialAPI };
