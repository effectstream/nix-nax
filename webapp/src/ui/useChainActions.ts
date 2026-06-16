// All on-chain actions + their eligibility, as a hook. Shared by the
// blockchain-actions drawer (GameMenu) and the win overlay so the settle /
// claim / timeout / fraud logic lives in exactly one place. Lifted verbatim
// from the old ActionsPanel; logging now goes to the JS console via logEvent.

import { useState } from "react";
import { api, type ContractState } from "../chain/arena.ts";
import { encodePath } from "../../../src/sdk/game/messaging.ts";
import { logEvent } from "../game/log-store.ts";
import type { PlayerSession } from "../game/player-session.ts";

const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");

export interface ChainActions {
  busy: string | null;
  error: string | null;
  settled: boolean;
  canSettle: boolean;
  canClaimResult: boolean;
  canStartTimeout: boolean;
  canClaimTimeout: boolean;
  canProveT: boolean;
  canProveI: boolean;
  canProveR: boolean;
  canProveP: boolean;
  settle: () => void;
  claimResult: () => void;
  startTimeout: () => void;
  claimTimeout: () => void;
  proveT: () => void;
  proveI: () => void;
  proveR: () => void;
  proveP: () => void;
}

export function useChainActions(
  session: PlayerSession,
  chain: ContractState | null,
  onRefresh: () => void,
): ChainActions {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Status enum: 0=halfOpen, 1=inProgress, 2=settled.
  const settled = chain?.status === 2;
  const halfOpen = chain?.status === 0;
  const chainDecided = (chain?.winner ?? 0) !== 0;
  const canSettle =
    !settled && !halfOpen && !chainDecided &&
    session.committedTurns > (chain?.committedTurns ?? 0);
  const challengeOpen = !!chain?.hasChallenge;
  const challengeExpired =
    challengeOpen && Number(chain!.challengeUntil) <= Math.floor(Date.now() / 1000);
  // A decided game (winner x=1 / o=2) can only be finalised by the winner — who
  // mints the win-token. A draw / undecided settlement is finalisable by either
  // participant (no mint). So hide "Redeem" from the loser.
  const myMark = session.role === "x" ? 1 : 2;
  const decidedWinner = chain?.winner === 1 || chain?.winner === 2;
  const iWon = decidedWinner && chain?.winner === myMark;
  const canClaimResult =
    !settled && !halfOpen && challengeExpired && (!decidedWinner || iWon);
  const deadlineExpired =
    !!chain?.hasDeadline && Number(chain.deadline) <= Math.floor(Date.now() / 1000);
  const canClaimTimeout = !settled && !halfOpen && deadlineExpired;
  const canStartTimeout =
    !settled && !halfOpen && !chainDecided &&
    !!chain && !chain.hasDeadline && chain.committedTurns > 0 &&
    chain.turnMark !== (session.role === "x" ? 1 : 2);

  const fraudT = session.detectEquivocation();
  const fraudI = session.detectIndexEquivocation();
  const fraudR = session.detectRandomEquivocation();
  const fraudP = chain ? session.detectWrongParity(chain.actionLog ?? []) : null;
  const canProveT = !settled && !halfOpen && !!fraudT;
  const canProveI = !settled && !halfOpen && !!fraudI;
  const canProveR = !settled && !halfOpen && !!fraudR;
  const canProveP = !settled && !halfOpen && !!fraudP;

  const wrap = (label: string, fn: () => Promise<unknown>) => () => {
    setError(null);
    setBusy(label);
    void (async () => {
      try {
        await fn();
      } catch (e) {
        const msg = (e as Error).message;
        setError(msg);
        logEvent(`ERROR ${label}: ${msg}`);
      } finally {
        setBusy(null);
        onRefresh();
      }
    })();
  };

  const side = (): "x" | "o" => (session.role === "x" ? "o" : "x"); // fraud is by the opponent

  return {
    busy, error, settled,
    canSettle, canClaimResult, canStartTimeout, canClaimTimeout,
    canProveT, canProveI, canProveR, canProveP,

    settle: wrap("Submit", async () => {
      const from = chain?.committedTurns ?? 0;
      const challengeWindowSec = 12;
      const untilTime = Math.floor(Date.now() / 1000) + challengeWindowSec;
      const chunks = session.settleChunkPayloads(from, untilTime);
      if (chunks.length === 0) { logEvent("settle: nothing to extend"); return; }
      logEvent(`settle: ${session.committedTurns - from} move(s) in ${chunks.length} chunk(s)…`);
      for (let i = 0; i < chunks.length; i++) {
        const r = await api.settle({ gameId: session.gameId, secret: hex(session.keys.secret), ...chunks[i] });
        logEvent(`settle chunk ${i + 1}/${chunks.length}: tx ${r.txId}`);
      }
    }),

    claimResult: wrap("Redeem", async () => {
      const r = await api.claimResult(session.gameId, hex(session.keys.secret));
      logEvent(`claim-result: tx ${r.txId}`);
    }),

    startTimeout: wrap("Start timeout", async () => {
      const untilTime = String(Math.floor(Date.now() / 1000) + 30);
      const r = await api.startTimeout(session.gameId, hex(session.keys.secret), untilTime);
      logEvent(`start-timeout: tx ${r.txId}`);
    }),

    claimTimeout: wrap("Claim timeout", async () => {
      const r = await api.claimTimeout(session.gameId);
      logEvent(`claim-timeout: tx ${r.txId}`);
    }),

    proveT: wrap("Prove action fork", async () => {
      const p = fraudT!;
      const r = await api.proveFraud({
        gameId: session.gameId, side: side(), turn: p.turn,
        kindA: p.kindA, cellA: p.cellA, sizeA: p.sizeA, secretA: hex(p.secretA), pathA: encodePath(p.pathA),
        kindB: p.kindB, cellB: p.cellB, sizeB: p.sizeB, secretB: hex(p.secretB), pathB: encodePath(p.pathB),
      });
      logEvent(`prove-fraud: tx ${r.txId}`);
    }),

    proveI: wrap("Prove slot fork", async () => {
      const p = fraudI!;
      const r = await api.proveIndexFraud({
        gameId: session.gameId, side: side(), turn: p.turn,
        slotA: p.slotA, bitsA: p.bitsA, secretA: hex(p.secretA), pathA: encodePath(p.pathA),
        slotB: p.slotB, bitsB: p.bitsB, secretB: hex(p.secretB), pathB: encodePath(p.pathB),
      });
      logEvent(`prove-index-fraud: tx ${r.txId}`);
    }),

    proveR: wrap("Prove random fork", async () => {
      const p = fraudR!;
      const r = await api.proveRandomFraud({
        gameId: session.gameId, side: side(), turn: p.turn, slot: p.slot,
        bitsA: p.bitsA, randomA: hex(p.randomA), pathA: encodePath(p.pathA),
        bitsB: p.bitsB, randomB: hex(p.randomB), pathB: encodePath(p.pathB),
      });
      logEvent(`prove-random-fraud: tx ${r.txId}`);
    }),

    proveP: wrap("Prove wrong parity", async () => {
      const p = fraudP!;
      const r = await api.proveWrongParity({
        gameId: session.gameId, turn: p.turn, slot: p.slot,
        bitsI: p.bitsI, secretI: hex(p.secretI), pathI: encodePath(p.pathI),
        bitsR: p.bitsR, randomR: hex(p.randomR), pathR: encodePath(p.pathR),
      });
      logEvent(`prove-wrong-parity: tx ${r.txId}`);
    }),
  };
}
