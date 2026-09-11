// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

import { useEffect, useState } from "react";
import { api } from "../../chain/arena.ts";
import type { ContractState } from "../../chain/types.ts";
import { generatePlayerKeys, PlayerSession } from "../../game/player-session.ts";
import { dropSession, listSessions, loadSession, isVsAi, clearVsAi, type IndexEntry } from "../../game/storage.ts";
import { createDurableGame, joinDurably, prepareJoin } from "../../game/onboarding.ts";
import { canReconnectSavedGame } from "../../game/reconnect.ts";
import { logEvent } from "../../game/log-store.ts";
import { colorOfRole } from "../../game/labels.ts";
import { submitCreateGame, submitJoin } from "../../wallet/submit.ts";
import { randomGameId } from "../../../../src/sdk/crypto/persistent-hash.ts";
import { useWallet } from "../../wallet/useWallet.ts";
import { isConnected, openWalletModal } from "../../wallet/state.ts";
import { pingRelay } from "../../api/ws.ts";

type Role = "x" | "o";
type View = "menu" | "join" | "reconnect";

const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");

// Let the browser paint the loading overlay before the synchronous Merkle-tree
// build freezes the main thread. A setTimeout macrotask (not requestAnimationFrame)
// so it still resolves in a backgrounded/headless tab, where rAF is paused.
const yieldPaint = () => new Promise<void>((r) => setTimeout(r, 40));

const stateSummary = (s: ContractState): string =>
  s.status === 0 ? "waiting for opponent"
  : s.status === 1 ? `in progress · ${s.committedTurns} turn(s)`
  : `settled · winner ${s.winnerName === "draw" ? "draw" : colorOfRole(s.winnerName as "x" | "o")}`;

export function useLobbyController(onOpen: (session: PlayerSession) => void) {
  const [view, setView] = useState<View>("menu");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [joinId, setJoinId] = useState("");
  const [reconId, setReconId] = useState("");
  const [reconRole, setReconRole] = useState<Role>("o");
  const [saved, setSaved] = useState<IndexEntry[]>([]);
  const [states, setStates] = useState<Record<string, string>>({});
  const wallet = useWallet();
  const connected = isConnected(wallet);
  const [relayUp, setRelayUp] = useState<boolean | null>(null); // null = still checking

  // Lobby actions require a connected wallet (the local Session Wallet + Auto
  // Faucet, or a real extension). If none, open the Wallet panel to prompt one.
  const gated = (action: () => void) => () => {
    if (!connected) {
      setError("Connect a wallet to play — choose one in the Wallet panel.");
      openWalletModal();
      return;
    }
    action();
  };

  useEffect(() => {
    const list = listSessions();
    setSaved(list);
    api.health()
      .then((h) => logEvent(`chain reachable${h.arena ? ` — arena ${h.arena.slice(0, 12)}…` : ""}`))
      .catch((e) => logEvent(`! chain unreachable: ${(e as Error).message}`));
    // Ping the multiplayer relay — when it's offline (e.g. a static deploy with no
    // relay server) the multiplayer modes are disabled; Practice vs AI still works.
    pingRelay().then((up) => {
      setRelayUp(up);
      logEvent(up ? "relay: online — multiplayer available" : "relay: offline — Practice vs AI only");
    });
    // Fetch each saved game's on-chain state for the Reconnect list.
    const seen = new Set<string>();
    for (const e of list) {
      if (seen.has(e.addr)) continue;
      seen.add(e.addr);
      api.state(e.addr)
        .then((s) => setStates((m) => ({ ...m, [e.addr]: stateSummary(s) })))
        .catch(() => setStates((m) => ({ ...m, [e.addr]: "unknown (relay/chain)" })));
    }
  }, []);

  // New game: random gameId + keys, then ONE fast createGame call. With
  // `vsAi`, the game is flagged so GameView spins up a local AI as BLUE/O.
  const newGame = async (vsAi = false) => {
    setError(null);
    setBusy(vsAi ? "Starting AI match — building Merkle trees…" : "Creating game — building Merkle trees…");
    await yieldPaint();
    try {
      const gameId = randomGameId();
      const gidHex = hex(gameId);
      logEvent(`create-game: generating keys for ${gidHex.slice(0, 12)}…`);
      const x = generatePlayerKeys("x", gameId);
      const xSession = new PlayerSession("x", gidHex, x, null);
      setBusy("Creating game — submitting transaction…");
      await yieldPaint();
      logEvent("create-game: submitting tx…");
      const res = await createDurableGame(xSession, submitCreateGame, vsAi);
      logEvent(`create-game: submitted via ${res.via}${res.txId ? ` (tx ${res.txId.slice(0, 16)}…)` : ""}`);
      logEvent(vsAi
        ? `vs-AI game ${gidHex.slice(0, 12)}… created — the AI (BLUE) will join shortly`
        : `game ${gidHex.slice(0, 12)}… created — share the game id with the BLUE player`);
      onOpen(xSession);
    } catch (e) {
      setError((e as Error).message);
      logEvent(`! create-game failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  // Join: O generates their own keys for the pasted gameId.
  const joinGame = async () => {
    setError(null);
    const gidHex = joinId.trim().toLowerCase().replace(/^0x/, "");
    if (!/^[0-9a-f]{64}$/.test(gidHex)) { setError("game id must be 64 hex chars"); return; }
    setBusy("Joining — building Merkle trees…");
    await yieldPaint();
    try {
      const gameId = Uint8Array.from(gidHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
      const prepared = prepareJoin(gidHex, () => {
        logEvent(`join: generating keys for ${gidHex.slice(0, 12)}…`);
        const keys = generatePlayerKeys("o", gameId);
        return new PlayerSession("o", gidHex, keys, null);
      });
      if (prepared.reused) {
        logEvent(`join: reusing saved BLUE identity for ${gidHex.slice(0, 12)}…`);
      }
      setBusy("Joining — submitting transaction…");
      await yieldPaint();
      logEvent("join: submitting tx…");
      const { result, reconciled } = await joinDurably(prepared, submitJoin, api.state);
      if (result) {
        const r = result;
        logEvent(`join: submitted via ${r.via}${r.txId ? ` (tx ${r.txId.slice(0, 16)}…)` : ""}`);
      } else if (reconciled) {
        logEvent("join: already on-chain with our saved credentials (idempotent)");
      }
      onOpen(prepared.session);
    } catch (e) {
      setError((e as Error).message);
      logEvent(`! join failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const removeSession = (addr: string, role: Role) => {
    dropSession(addr, role);
    clearVsAi(addr);
    setSaved(listSessions());
    logEvent(`removed ${colorOfRole(role)} session for ${addr.slice(0, 12)}… from this browser`);
  };

  const reconnect = (gameId: string, role: Role) => {
    setError(null);
    const normalized = gameId.trim().toLowerCase().replace(/^0x/, "");
    if (!canReconnectSavedGame(relayUp, isVsAi(normalized))) {
      setError("The multiplayer relay is offline. Saved Practice vs AI games can still be resumed.");
      return;
    }
    const stored = loadSession(normalized, role);
    if (!stored) { setError(`No saved ${colorOfRole(role)} session for that game id in this browser.`); return; }
    logEvent(`reconnected ${colorOfRole(role)} session for ${gameId.slice(0, 12)}…`);
    onOpen(PlayerSession.restore(stored));
  };

  return {
    view, setView, busy, error, setError, joinId, setJoinId, reconId, setReconId,
    reconRole, setReconRole, saved, states, connected, relayUp, gated, newGame,
    joinGame, removeSession, reconnect,
  };
}
