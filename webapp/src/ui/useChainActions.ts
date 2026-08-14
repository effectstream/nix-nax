// All on-chain actions + their eligibility, as a hook. Shared by the
// blockchain-actions drawer (GameMenu) and the win overlay so the settle /
// claim logic lives in exactly one place. Logging goes to the JS console via
// logEvent.
//
// SIMPLIFIED (teaching) version: the contract trusts the players, so the
// fraud / dispute / timeout actions are gone and there is no challenge
// window — a decided game is redeemable immediately.

import { useState } from "react";
import { api, type ContractState } from "../chain/arena.ts";
import { logEvent } from "../game/log-store.ts";
import type { PlayerSession } from "../game/player-session.ts";

const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");

// midnight-js throws the raw FinalizedTxData JSON when a landed tx's fallible
// segment fails on-chain. Translate it for the UI; the raw JSON still goes to
// the console via logEvent.
function friendlyTxError(msg: string): string {
  if (msg.includes("SegmentFail") || msg.includes("FailFallible")) {
    return "The transaction landed on-chain but a contract check rejected it (segment failed). " +
      "The on-chain state may have moved while proving — refresh and try again.";
  }
  return msg;
}

export interface ChainActions {
  busy: string | null;
  // What the in-flight action is doing right now ("proving chunk 1/3…") —
  // ZK proving takes minutes, so the UI must say why it's waiting.
  status: string | null;
  error: string | null;
  settled: boolean;
  canSettle: boolean;
  canClaimResult: boolean;
  settle: () => void;
  claimResult: () => void;
}

export function useChainActions(
  session: PlayerSession,
  chain: ContractState | null,
  onRefresh: () => void,
): ChainActions {
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Status enum: 0=halfOpen, 1=inProgress, 2=settled.
  const settled = chain?.status === 2;
  const halfOpen = chain?.status === 0;
  const chainDecided = (chain?.winner ?? 0) !== 0;
  const canSettle =
    !settled && !halfOpen && !chainDecided &&
    session.committedTurns > (chain?.committedTurns ?? 0);
  // A decided game (winner x=1 / o=2) can only be finalised by the winner — who
  // mints the win-token. A draw is finalisable by either participant (no mint).
  // So hide "Redeem" from the loser. No waiting window in this version.
  const myMark = session.role === "x" ? 1 : 2;
  const decidedWinner = chain?.winner === 1 || chain?.winner === 2;
  const iWon = decidedWinner && chain?.winner === myMark;
  const canClaimResult =
    !settled && !halfOpen && chainDecided && (!decidedWinner || iWon);

  const wrap = (label: string, fn: () => Promise<unknown>) => () => {
    setError(null);
    setBusy(label);
    setStatus("Building + proving the transaction — approve in your wallet when prompted…");
    void (async () => {
      try {
        await fn();
      } catch (e) {
        const msg = (e as Error).message;
        setError(friendlyTxError(msg));
        logEvent(`ERROR ${label}: ${msg}`);
      } finally {
        setBusy(null);
        setStatus(null);
        onRefresh();
      }
    })();
  };

  return {
    busy, status, error, settled,
    canSettle, canClaimResult,

    settle: wrap("Submit", async () => {
      const from = chain?.committedTurns ?? 0;
      const chunks = session.settleChunkPayloads(from);
      if (chunks.length === 0) { logEvent("settle: nothing to extend"); return; }
      logEvent(`settle: ${session.committedTurns - from} move(s) in ${chunks.length} chunk(s)…`);
      for (let i = 0; i < chunks.length; i++) {
        setStatus(`Proving settle chunk ${i + 1}/${chunks.length} (${chunks[i].nMoves} move${chunks[i].nMoves === 1 ? "" : "s"}) — this takes a few minutes. Approve each tx in your wallet…`);
        const r = await api.settle({ gameId: session.gameId, ...chunks[i] });
        logEvent(`settle chunk ${i + 1}/${chunks.length}: tx ${r.txId}`);
      }
    }),

    claimResult: wrap("Redeem", async () => {
      const r = await api.claimResult(session.gameId, hex(session.keys.secret));
      logEvent(`claim-result: tx ${r.txId}`);
    }),
  };
}
