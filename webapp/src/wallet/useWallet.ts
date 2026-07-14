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

// The store lives on globalThis so it survives Vite HMR re-instantiating this
// module: with a plain module-level variable, an HMR update can leave the UI
// writing the connection into one module instance while chain code reads a
// fresh empty one — "connected" in the header, "no wallet" at submit time.
interface WalletStore { state: WalletState; subs: Set<() => void> }
const store: WalletStore = ((globalThis as any).__nixnaxWalletStore ??= {
  state: { mode: null, api: null, name: null, address: null, dust: null, connecting: false, modalOpen: false } as WalletState,
  subs: new Set<() => void>(),
});
const set = (next: Partial<WalletState>) => { store.state = { ...store.state, ...next }; for (const f of store.subs) f(); };

export const walletApi = (): ConnectedAPI | null => store.state.api;

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
    // Address/dust are display data — a failure must not block the connection,
    // but it must be VISIBLE (a silent null makes the button fall back to the
    // extension name and hides real problems, e.g. an insecure http:// origin
    // degrading the extension API). Log the reason and retry once.
    const readDisplayData = async (label: string) => {
      const [addr, dust] = await Promise.all([
        api.getUnshieldedAddress().catch((e: Error) => {
          logEvent(`! wallet getUnshieldedAddress failed${label}: ${e.message}`);
          return null;
        }),
        api.getDustBalance().catch((e: Error) => {
          logEvent(`! wallet getDustBalance failed${label}: ${e.message}`);
          return null;
        }),
      ]);
      return { addr, dust };
    };
    let { addr, dust } = await readDisplayData("");
    set({ mode: "wallet", api, name: wallet.name, address: addr?.unshieldedAddress ?? null, dust, connecting: false });
    if (!addr || !dust) {
      // One delayed retry — extensions can briefly refuse data right after
      // connect (still unlocking/syncing).
      setTimeout(() => {
        void readDisplayData(" (retry)").then((r) => {
          if (r.addr || r.dust) {
            set({
              ...(r.addr ? { address: r.addr.unshieldedAddress } : {}),
              ...(r.dust ? { dust: r.dust } : {}),
            });
          }
        });
      }, 3000);
    }
    // Drop any cached arena handle built for the previous wallet mode so the
    // next on-chain action attaches via this connection. (Dynamic import:
    // arena.ts statically imports this module — avoid the cycle.)
    void import("../chain/arena.ts").then((m) => m.resetArena()).catch(() => {});
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
    (cb) => { store.subs.add(cb); return () => store.subs.delete(cb); },
    () => store.state,
  );
}

export { hasWalletExtension, listWallets };
export type { InitialAPI };
