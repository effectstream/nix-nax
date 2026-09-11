// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

import { useEffect, useState } from "react";
import { useWallet } from "../../wallet/useWallet.ts";
import {
  beginWalletSelection, closeWalletModal, connect, connectSessionWallet, disconnect,
  finishWalletSelection, isConnected, isWalletGenerationCurrent, listWallets,
  openWalletModal, readWalletPreference, walletGeneration, NETWORK_ID,
  type InitialAPI,
} from "../../wallet/state.ts";
import {
  fundConnectedWallet, hasStoredSessionWallet, restoreSessionWallet, runFaucet,
  type FaucetResult,
} from "../../wallet/faucet.ts";
import { readWinBalance } from "../../chain/arena.ts";

export function useWalletController() {
  const wallet = useWallet();
  const open = wallet.modalOpen;
  const [faucetRunning, setFaucetRunning] = useState(false);
  const [extFunding, setExtFunding] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [faucetLog, setFaucetLog] = useState<string[]>([]);
  const [session, setSession] = useState<FaucetResult | null>(null);
  const wallets = listWallets();
  const isLocal = NETWORK_ID === "undeployed";
  const connected = isConnected(wallet);

  // Win-token count for the connected wallet — read as soon as it connects,
  // re-read when the modal opens (e.g. right after a Redeem).
  const [wins, setWins] = useState<number | null>(null);
  useEffect(() => {
    if (!connected) { setWins(null); return; }
    let live = true;
    void readWinBalance().then((n) => { if (live) setWins(n); }).catch(() => {});
    return () => { live = false; };
  }, [connected, wallet.address, open]);

  const pickWallet = async (w: InitialAPI) => {
    setFaucetRunning(false);
    setExtFunding(false);
    setRestoring(false);
    closeWalletModal();
    await connect(w);
  };

  // Put back only the explicitly remembered local wallet. A stored seed alone
  // is not consent, and extension reconnect remains user initiated.
  useEffect(() => {
    if (!isLocal || connected) return;
    if (readWalletPreference() !== "local" || !hasStoredSessionWallet()) return;
    let live = true;
    const generation = beginWalletSelection();
    setRestoring(true);
    void restoreSessionWallet((s) => {
      if (live && isWalletGenerationCurrent(generation)) setFaucetLog((l) => [...l.slice(-7), s]);
    })
      .then((r) => {
        if (!live || !r || !isWalletGenerationCurrent(generation)) return;
        setSession(r);
        connectSessionWallet(r.address, generation);
      })
      .catch((e) => {
        if (live && isWalletGenerationCurrent(generation)) setFaucetLog((l) => [...l, "❌ " + (e as Error).message]);
      })
      .finally(() => {
        finishWalletSelection(generation);
        if (live && isWalletGenerationCurrent(generation)) setRestoring(false);
      });
    return () => { live = false; };
    // Mount-only: the guards above decide whether it runs at all.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doDisconnect = () => {
    setSession(null);
    setFaucetLog([]);
    setFaucetRunning(false);
    setExtFunding(false);
    setRestoring(false);
    disconnect();
  };

  const doFaucet = () => {
    const generation = beginWalletSelection();
    setFaucetRunning(true);
    setRestoring(false);
    setExtFunding(false);
    setFaucetLog([]);
    void (async () => {
      try {
        const r = await runFaucet((s) => {
          if (isWalletGenerationCurrent(generation)) setFaucetLog((l) => [...l.slice(-7), s]);
        });
        if (!isWalletGenerationCurrent(generation)) return;
        setSession(r);
        connectSessionWallet(r.address, generation);
      } catch (e) {
        if (isWalletGenerationCurrent(generation)) {
          setFaucetLog((l) => [...l, "❌ " + (e as Error).message]);
        }
      } finally {
        finishWalletSelection(generation);
        if (isWalletGenerationCurrent(generation)) setFaucetRunning(false);
      }
    })();
  };

  const doFundConnected = () => {
    if (!wallet.address) return;
    const generation = walletGeneration();
    const address = wallet.address;
    setExtFunding(true);
    setFaucetLog([]);
    void (async () => {
      try {
        await fundConnectedWallet(address, (s) => {
          if (isWalletGenerationCurrent(generation)) setFaucetLog((l) => [...l.slice(-7), s]);
        });
      } catch (e) {
        if (isWalletGenerationCurrent(generation)) {
          setFaucetLog((l) => [...l, "❌ " + (e as Error).message]);
        }
      } finally {
        if (isWalletGenerationCurrent(generation)) setExtFunding(false);
      }
    })();
  };

  return {
    wallet, open, faucetRunning, extFunding, restoring, faucetLog, session, wallets,
    isLocal, connected, wins, pickWallet, doDisconnect, doFaucet, doFundConnected,
    openWalletModal, closeWalletModal, hasStoredSessionWallet, NETWORK_ID,
  };
}
