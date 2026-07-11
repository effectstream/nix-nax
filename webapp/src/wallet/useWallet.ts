// Connected-wallet store + React hook. A module-level store (so the dual-mode
// Submitter and the UI share one connection) plus useSyncExternalStore.

import { useSyncExternalStore } from "react";
import { listWallets, connectWallet, hasWalletExtension, type ConnectedAPI, type InitialAPI } from "./connector.ts";
import { logEvent } from "../game/log-store.ts";

// The dev stack runs the "undeployed" network; real envs override via
// VITE_NETWORK_ID (see chain/env.ts). The wallet must match it to connect.
import { NETWORK_ID } from "../chain/env.ts";
export { NETWORK_ID };

// "wallet" = a connected browser-extension wallet pays its own gas; "local" =
// the "Session Wallet + Auto Faucet" — a per-browser wallet the faucet funds and
// registers for dust, which then pays gas (undeployed dev only).
export type WalletMode = "wallet" | "local";

export interface WalletState {
  mode: WalletMode | null;
  api: ConnectedAPI | null;
  name: string | null;
  address: string | null;
  dust: { cap: bigint; balance: bigint } | null;
  connecting: boolean;
  modalOpen: boolean; // wallet panel visibility — shared so the lobby can prompt to connect
}

let state: WalletState = { mode: null, api: null, name: null, address: null, dust: null, connecting: false, modalOpen: false };
const subs = new Set<() => void>();
const set = (next: Partial<WalletState>) => { state = { ...state, ...next }; for (const f of subs) f(); };

export const walletApi = (): ConnectedAPI | null => state.api;

// A gas-paying wallet is connected: an injected extension OR the local session wallet.
export const isConnected = (s: WalletState): boolean => s.mode === "wallet" || s.mode === "local";

// Wallet panel open/close — shared via the store so Home can prompt the user.
export function openWalletModal(): void { set({ modalOpen: true }); }
export function closeWalletModal(): void { set({ modalOpen: false }); }

// Connect a specific browser-extension wallet → it pays the player's gas.
export async function connect(wallet: InitialAPI): Promise<void> {
  set({ connecting: true });
  try {
    const api = await connectWallet(wallet, NETWORK_ID);
    // ENFORCE network match: passing NETWORK_ID to connect() is only a request —
    // extensions may connect on whatever network they're set to. A wallet on a
    // different chain than the app can't fund gas or see the arena, so reject it
    // with a clear message instead of leaving a silently-broken connection.
    const cfg = await api.getConfiguration().catch(() => null);
    if (cfg && cfg.networkId !== NETWORK_ID) {
      set({ connecting: false });
      logEvent(`! wallet on network "${cfg.networkId}" but the app is on "${NETWORK_ID}" — switch the wallet's network and reconnect`);
      return;
    }
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

// "Session Wallet + Auto Faucet" (undeployed dev): the faucet funded a per-browser
// session wallet (or kept genesis as the dust payer) and made it the gas payer.
// Reflect it in the shared store so the lobby knows a wallet is ready to play.
export function connectSessionWallet(address: string): void {
  set({ mode: "local", api: null, name: "Session Wallet + Auto Faucet", address, connecting: false });
}

export function disconnect(): void {
  set({ mode: null, api: null, name: null, address: null, dust: null });
  logEvent("wallet: disconnected");
}

export function useWallet(): WalletState {
  return useSyncExternalStore(
    (cb) => { subs.add(cb); return () => subs.delete(cb); },
    () => state,
  );
}

export { hasWalletExtension, listWallets };
export type { InitialAPI };
