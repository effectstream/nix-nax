// All on-chain actions + their eligibility, as a hook. Shared by the
// blockchain-actions drawer (GameMenu) and the win overlay so the settle /
// claim / timeout / fraud logic lives in exactly one place. Lifted verbatim
// from the old ActionsPanel; logging now goes to the JS console via logEvent.

import { useState } from "react";
import { api, type ContractState } from "../chain/arena.ts";
import { encodePath } from "../../../src/sdk/game/messaging.ts";
import { MIN_CHALLENGE_SECS, MIN_TIMEOUT_SECS, MIN_RESPONSE_SECS } from "../../../src/sdk/game/rules.ts";
import { logEvent } from "../game/log-store.ts";
import type { PlayerSession } from "../game/player-session.ts";

const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");

export interface ChainActions {
  busy: string | null;
  // What the in-flight action is doing right now ("proving chunk 1/3…") —
  // ZK proving takes minutes, so the UI must say why it's waiting.
  status: string | null;
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
  canChallengeRoll: boolean;
  canAnswerRoll: boolean;
  canClaimRoll: boolean;
  settle: () => void;
  claimResult: () => void;
  startTimeout: () => void;
  claimTimeout: () => void;
  proveT: () => void;
  proveI: () => void;
  proveR: () => void;
  proveP: () => void;
  challengeRoll: () => void;
  answerRoll: () => void;
  claimRoll: () => void;
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
  const challengeOpen = !!chain?.hasChallenge;
  const challengeExpired =
    challengeOpen && Number(chain!.challengeUntil) <= Math.floor(Date.now() / 1000);
  // A decided game (winner x=1 / o=2) can only be finalised by the winner — who
  // mints the win-token. A draw / undecided settlement is finalisable by either
  // participant (no mint). So hide "Redeem" from the loser.
  const myMark = session.role === "x" ? 1 : 2;
  const decidedWinner = chain?.winner === 1 || chain?.winner === 2;
  const iWon = decidedWinner && chain?.winner === myMark;
  // Roll-class dispute state (see challengeRoll/answerRoll/claimRoll below).
  const rollPending = !!chain?.hasRollChallenge;
  const unseenTurn = chain && !settled ? session.detectUnseenRoll(chain.actionLog ?? []) : null;
  const answerPayload =
    rollPending && (chain!.challengeTurn % 2 === 0 ? 1 : 2) === myMark
      ? session.rollAnswerFor(chain!.challengeTurn)
      : null;
  const respondExpired =
    rollPending && Number(chain!.respondBy) <= Math.floor(Date.now() / 1000);
  // Finalisable once decided (win or draw) with no window pending: optimistic
  // wins wait out the challenge window; fraud/timeout wins carry no window and
  // finalise immediately. A pending roll dispute blocks it either way.
  const windowClear = !challengeOpen || challengeExpired;
  const canClaimResult =
    !settled && !halfOpen && chainDecided && windowClear && !rollPending &&
    (!decidedWinner || iWon);
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
  const canChallengeRoll = !settled && !halfOpen && !rollPending && unseenTurn !== null;
  const canAnswerRoll = !settled && !halfOpen && rollPending && !!answerPayload;
  const canClaimRoll = !settled && !halfOpen && rollPending && respondExpired;

  const wrap = (label: string, fn: () => Promise<unknown>) => () => {
    setError(null);
    setBusy(label);
    setStatus("Building + proving the transaction — approve in your wallet when prompted…");
    void (async () => {
      try {
        await fn();
      } catch (e) {
        const msg = (e as Error).message;
        setError(msg);
        logEvent(`ERROR ${label}: ${msg}`);
      } finally {
        setBusy(null);
        setStatus(null);
        onRefresh();
      }
    })();
  };

  const side = (): "x" | "o" => (session.role === "x" ? "o" : "x"); // fraud is by the opponent

  return {
    busy, status, error, settled,
    canSettle, canClaimResult, canStartTimeout, canClaimTimeout,
    canProveT, canProveI, canProveR, canProveP,
    canChallengeRoll, canAnswerRoll, canClaimRoll,

    settle: wrap("Submit", async () => {
      const from = chain?.committedTurns ?? 0;
      // Must exceed the contract's MIN_CHALLENGE_SECS floor; add a buffer for
      // client-clock vs block-time skew so honest settles aren't rejected.
      const challengeWindowSec = MIN_CHALLENGE_SECS + 120;
      const untilTime = Math.floor(Date.now() / 1000) + challengeWindowSec;
      const chunks = session.settleChunkPayloads(from, untilTime);
      if (chunks.length === 0) { logEvent("settle: nothing to extend"); return; }
      logEvent(`settle: ${session.committedTurns - from} move(s) in ${chunks.length} chunk(s)…`);
      for (let i = 0; i < chunks.length; i++) {
        setStatus(`Proving settle chunk ${i + 1}/${chunks.length} — the settle proof is the big one (a few minutes per chunk). Approve each tx in your wallet…`);
        const r = await api.settle({ gameId: session.gameId, secret: hex(session.keys.secret), ...chunks[i] });
        logEvent(`settle chunk ${i + 1}/${chunks.length}: tx ${r.txId}`);
      }
    }),

    claimResult: wrap("Redeem", async () => {
      const r = await api.claimResult(session.gameId, hex(session.keys.secret));
      logEvent(`claim-result: tx ${r.txId}`);
    }),

    startTimeout: wrap("Start timeout", async () => {
      const untilTime = String(Math.floor(Date.now() / 1000) + MIN_TIMEOUT_SECS + 120);
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

    // Demand the roll evidence for a committed opponent turn this client never
    // saw the ceremony for (unilateral settle). The mover must answer on-chain
    // before respondBy or forfeit via claimRoll.
    challengeRoll: wrap("Challenge roll", async () => {
      const respondBy = String(Math.floor(Date.now() / 1000) + MIN_RESPONSE_SECS + 120);
      const r = await api.challengeRoll(session.gameId, hex(session.keys.secret), unseenTurn!, respondBy);
      logEvent(`challenge-roll: turn ${unseenTurn} — tx ${r.txId}`);
    }),

    // Answer a pending challenge on my own turn with the ceremony reveals.
    answerRoll: wrap("Answer roll challenge", async () => {
      const p = answerPayload!;
      const r = await api.answerRollChallenge({
        gameId: session.gameId, slot: p.slot,
        bitsI: p.bitsI, secretI: hex(p.secretI), pathI: encodePath(p.pathI),
        bitsR: p.bitsR, randomR: hex(p.randomR), pathR: encodePath(p.pathR),
      });
      logEvent(`answer-roll-challenge: turn ${chain!.challengeTurn} — tx ${r.txId}`);
    }),

    // The challenge went unanswered past respondBy: claim the forfeit.
    claimRoll: wrap("Claim roll forfeit", async () => {
      const r = await api.claimRollChallenge(session.gameId);
      logEvent(`claim-roll-challenge: tx ${r.txId}`);
    }),
  };
}
