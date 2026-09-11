// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

import { useEffect, useRef, useState } from "react";
import type { WireInbound } from "../../api/ws.ts";
import { api, readWinBalance } from "../../chain/arena.ts";
import type { ContractState } from "../../chain/types.ts";
import { colorOfRole } from "../../game/labels.ts";
import { logEvent } from "../../game/log-store.ts";
import type { PlayerSession } from "../../game/player-session.ts";
import type { MessageHandlerRef, MessageQueueRef } from "./useGameRelay.ts";

const hexToBytes = (s: string): Uint8Array => {
  const h = (s.startsWith("0x") ? s.slice(2) : s).match(/.{1,2}/g) ?? [];
  return new Uint8Array(h.map((b) => parseInt(b, 16)));
};

export function useChainSnapshot(session: PlayerSession) {
  const [chain, setChain] = useState<ContractState | null>(null);
  const prevChainRef = useRef<ContractState | null>(null);

  // Single entry point for chain state so every transition is logged (to console).
  const applyChain = (s: ContractState) => {
    const p = prevChainRef.current;
    if (!p) {
      logEvent(`chain: ${s.statusName}, committedTurns=${s.committedTurns}, winner=${s.winnerName}`);
    } else {
      if (p.statusName !== s.statusName) logEvent(`chain: status ${p.statusName} -> ${s.statusName}`);
      if (p.committedTurns !== s.committedTurns) logEvent(`chain: committedTurns ${p.committedTurns} -> ${s.committedTurns}`);
      if (p.winnerName !== s.winnerName) logEvent(`chain: winner -> ${s.winnerName === "x" || s.winnerName === "o" ? colorOfRole(s.winnerName) : s.winnerName.toUpperCase()}`);
      if ((p.actionLog?.length ?? 0) !== (s.actionLog?.length ?? 0)) {
        logEvent(`chain: actionLog ${p.actionLog?.length ?? 0} -> ${s.actionLog?.length ?? 0} entries`);
      }
    }
    prevChainRef.current = s;
    setChain(s);
  };
  const refreshChain = () => { api.state(session.gameId).then(applyChain).catch(() => {}); };

  return { chain, applyChain, refreshChain };
}

export function useWinBalance(chain: ContractState | null): number | null {
  const [wins, setWins] = useState<number | null>(null);

  // Win-token balance (your wins) — shown in the game-info panel. Re-read on
  // mount and whenever the on-chain status changes (e.g. after Redeem mints one).
  useEffect(() => {
    void readWinBalance().then(setWins).catch(() => {});
  }, [chain?.status]);

  return wins;
}

export function useChainPolling(
  session: PlayerSession,
  applyChain: (state: ContractState) => void,
  force: () => void,
  pendingMsgsRef: MessageQueueRef,
  handleMsgRef: MessageHandlerRef,
) {
  // Chain polling also fills opponent commitments after join.
  useEffect(() => {
    let running = true;
    const poll = async () => {
      try {
        const s = await api.state(session.gameId);
        if (!running) return;
        applyChain(s);
        if (!session.opponentInfo) {
          const oppIsX = session.role === "o";
          const idBytes = hexToBytes(oppIsX ? s.idX : s.idO);
          const rootToken = BigInt(oppIsX ? s.rootX : s.rootO);
          if (rootToken !== 0n || !idBytes.every((b) => b === 0)) {
            session.setOpponent({ id: idBytes, rootToken });
            logEvent(`opponent commitment fetched from chain (${oppIsX ? "RED" : "BLUE"})`);
            force();
            // Replay relay messages that raced ahead of the commitments (in
            // arrival order) — without this the opponent's first roll intent is
            // dropped and the game hangs on "rolling".
            const queued: WireInbound[] = pendingMsgsRef.current.splice(0);
            if (queued.length) logEvent(`replaying ${queued.length} queued relay message(s)`);
            for (const m of queued) handleMsgRef.current?.(m);
          }
        }
      } catch (e) {
        if (running) logEvent(`! state poll error: ${(e as Error).message}`);
      }
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => { running = false; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.gameId]);
}
