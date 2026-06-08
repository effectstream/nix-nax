import { useState } from "react";
import { api, type ContractState } from "../api/http.ts";
import type { PlayerSession } from "../game/player-session.ts";

export interface ActionsPanelProps {
  session: PlayerSession;
  chain: ContractState | null;
  log: (msg: string) => void;
  onRefresh: () => void;
}

const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");

export default function ActionsPanel({ session, chain, log, onRefresh }: ActionsPanelProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Visibility logic — derive from local + chain.
  // Status enum after two-phase open: 0=halfOpen, 1=inProgress, 2=settled.
  const settled  = chain?.status === 2;
  const halfOpen = chain?.status === 0;
  // While halfOpen, nothing can be done on chain (settle/claim/timeout all require inProgress).
  const canSettle = !settled && !halfOpen && session.committedTurns > (chain?.committedTurns ?? 0);
  const challengeOpen = !!chain?.hasChallenge;
  const challengeExpired =
    challengeOpen && Number(chain!.challengeUntil) <= Math.floor(Date.now() / 1000);
  const canClaimResult = !settled && !halfOpen && challengeExpired;
  const deadlineExpired =
    chain?.hasDeadline && Number(chain.deadline) <= Math.floor(Date.now() / 1000);
  const canClaimTimeout = !settled && !halfOpen && !!deadlineExpired;
  const canStartTimeout =
    !settled && !halfOpen &&
    chain &&
    !chain.hasDeadline &&
    chain.committedTurns > 0 &&
    // Only the waiting player (mark != turnMark) can arm a timeout.
    chain.turnMark !== (session.role === "x" ? 1 : 2);
  const fraudProof = session.detectEquivocation();
  const canProveFraud = !settled && !halfOpen && !!fraudProof;

  const wrap = async (label: string, fn: () => Promise<unknown>) => {
    setError(null);
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      const msg = (e as Error).message;
      setError(msg);
      log(`ERROR ${label}: ${msg}`);
    } finally {
      setBusy(null);
      onRefresh();
    }
  };

  const settle = () =>
    wrap("Settle", async () => {
      const challengeWindowSec = 6;
      const untilTime = Math.floor(Date.now() / 1000) + challengeWindowSec;
      const body = {
        addr: session.contractAddress,
        secret: hex(session.keys.secret),
        ...session.settlePayload(untilTime),
      };
      log(`settle (${body.nMoves} moves)…`);
      const r = await api.settle(body);
      log(`settle: tx ${r.txId}`);
    });

  const claimResult = () =>
    wrap("Claim result", async () => {
      const r = await api.claimResult(session.contractAddress);
      log(`claim-result: tx ${r.txId}`);
    });

  const startTimeout = () =>
    wrap("Start timeout", async () => {
      const graceSec = 30;
      const untilTime = String(Math.floor(Date.now() / 1000) + graceSec);
      log(`start-timeout (until ${untilTime})…`);
      const r = await api.startTimeout(session.contractAddress, hex(session.keys.secret), untilTime);
      log(`start-timeout: tx ${r.txId}`);
    });

  const claimTimeout = () =>
    wrap("Claim timeout", async () => {
      const r = await api.claimTimeout(session.contractAddress);
      log(`claim-timeout: tx ${r.txId}`);
    });

  const proveFraud = () =>
    wrap("Prove fraud", async () => {
      const p = fraudProof!;
      const side = session.role === "x" ? "o" : "x"; // fraud is by the opponent
      log(`prove-fraud (side=${side}, turn=${p.turn})…`);
      const r = await api.proveFraud({
        addr: session.contractAddress,
        side,
        turn: p.turn,
        cellA: p.cellA, secretA: hex(p.secretA),
        pathA: {
          leaf: hex(p.pathA.leaf),
          path: p.pathA.path.map((e) => ({ sibling: "0x" + e.sibling.field.toString(16), goes_left: e.goes_left })),
        },
        cellB: p.cellB, secretB: hex(p.secretB),
        pathB: {
          leaf: hex(p.pathB.leaf),
          path: p.pathB.path.map((e) => ({ sibling: "0x" + e.sibling.field.toString(16), goes_left: e.goes_left })),
        },
      });
      log(`prove-fraud: tx ${r.txId}`);
    });

  return (
    <div className="card">
      <h3 style={{ margin: "0 0 12px" }}>Actions</h3>
      <div className="col">
        <button className="primary" disabled={!canSettle || busy !== null} onClick={settle}>
          {busy === "Settle" ? "Settling…" : "Settle on-chain"}
        </button>
        <button disabled={!canClaimResult || busy !== null} onClick={claimResult}>
          {busy === "Claim result" ? "Claiming…" : "Claim result (after window)"}
        </button>
        <button disabled={!canStartTimeout || busy !== null} onClick={startTimeout}>
          {busy === "Start timeout" ? "Arming…" : "Start timeout (opponent silent)"}
        </button>
        <button disabled={!canClaimTimeout || busy !== null} onClick={claimTimeout}>
          {busy === "Claim timeout" ? "Claiming…" : "Claim timeout"}
        </button>
        <button className="warn" disabled={!canProveFraud || busy !== null} onClick={proveFraud}>
          {busy === "Prove fraud" ? "Proving…" : canProveFraud ? "Prove fraud (opponent equivocated)" : "Prove fraud (none detected)"}
        </button>
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  );
}
