// Blockchain-actions drawer — slides in from the top-left hamburger. Holds the
// game's on-chain status + every blockchain action (settle/redeem, timeouts,
// and an Advanced fraud-proof group). Replaces the old right-hand sidebar's
// StatusPanel + ActionsPanel. Closes on backdrop click, ✕, or Esc.

import { useEffect, useState } from "react";
import type { ContractState } from "../chain/arena.ts";
import type { PlayerSession } from "../game/player-session.ts";
import type { ChainActions } from "./useChainActions.ts";
import { KIND_PLACE, KIND_REMOVE } from "../../../src/sdk/game/rules.ts";
import { colorOfRole, colorOfMark } from "../game/labels.ts";

const STATUS_LABEL = ["halfOpen (waiting for BLUE)", "in progress", "settled"];
const WINNER_LABEL = ["none", "RED", "BLUE", "Draw"];
const SIZE_LABEL = ["XS", "S", "M", "L"];

const shortHex = (b: Uint8Array) => {
  const h = Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}…${h.slice(-8)}`;
};

export interface GameMenuProps {
  open: boolean;
  onClose: () => void;
  session: PlayerSession;
  chain: ContractState | null;
  wsStatus: "connecting" | "open" | "closed";
  actions: ChainActions;
  onLeave: () => void;
}

export default function GameMenu({ open, onClose, session, chain, wsStatus, actions, onLeave }: GameMenuProps) {
  const [now, setNow] = useState(Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const challenge = chain?.hasChallenge ? Math.max(0, Number(chain.challengeUntil) - now) : null;
  const deadline = chain?.hasDeadline ? Math.max(0, Number(chain.deadline) - now) : null;
  const wsTag = wsStatus === "open" ? "good" : wsStatus === "connecting" ? "warn" : "bad";
  const localWinner = session.winnerLocal;
  const records = session.turnRecords();
  const a = actions;
  const advanced = a.canProveT || a.canProveI || a.canProveR || a.canProveP;
  const dispute = a.canChallengeRoll || a.canAnswerRoll || a.canClaimRoll;

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer glass" role="dialog" aria-label="Blockchain actions">
        <div className="drawer-head">
          <h2>Blockchain</h2>
          <button className="btn-glass btn-sm" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="kvs">
          <div className="k">Game id</div>
          <div className="v">
            {session.gameId.slice(0, 12)}…{session.gameId.slice(-6)}
            <button className="copy-btn btn-glass" onClick={() => navigator.clipboard.writeText(session.gameId)}>copy</button>
          </div>
          <div className="k">You are</div>
          <div className="v"><span className={`tag ${session.role}`}>{colorOfRole(session.role)}</span></div>
          <div className="k">Relay</div>
          <div className="v"><span className={`tag ${wsTag}`}>{wsStatus}</span></div>
          <div className="k">Local game</div>
          <div className="v">
            {session.gameStatus === "ended"
              ? `ended — ${localWinner === "draw" ? "draw" : colorOfMark(localWinner as number) + " wins"}`
              : `turn ${session.currentTurn} (${colorOfRole(session.nextTurnRole)} to act)`}
          </div>
          <div className="k">On-chain</div>
          <div className="v">{chain ? STATUS_LABEL[chain.status] ?? `?(${chain.status})` : "—"}</div>
          <div className="k">On-chain winner</div>
          <div className="v">
            {chain && chain.winner !== 0
              ? <span className={`tag ${chain.winner === 3 ? "warn" : "good"}`}>{WINNER_LABEL[chain.winner]}</span>
              : "—"}
          </div>
          <div className="k">Committed turns</div>
          <div className="v">{chain?.committedTurns ?? "—"} / local {session.committedTurns}</div>
          {challenge !== null && (
            <>
              <div className="k">Challenge</div>
              <div className="v">{challenge > 0 ? <span className="tag warn">{challenge}s left</span> : <span className="tag good">expired — redeem</span>}</div>
            </>
          )}
          {deadline !== null && (
            <>
              <div className="k">Timeout</div>
              <div className="v">{deadline > 0 ? <span className="tag warn">{deadline}s left</span> : <span className="tag good">expired — claim</span>}</div>
            </>
          )}
        </div>

        <div className="section-title">Record the result</div>
        <div className="col">
          <button className="btn-o btn-block" disabled={!a.canSettle || a.busy !== null} onClick={a.settle}>
            {a.busy === "Submit" ? "Submitting…" : "Submit result (settle on-chain)"}
          </button>
          <button className="btn-o btn-block" disabled={!a.canClaimResult || a.busy !== null} onClick={a.claimResult}>
            {a.busy === "Redeem" ? "Redeeming…" : "Redeem (claim result)"}
          </button>
        </div>

        <div className="section-title">If your opponent stalls</div>
        <div className="col">
          <button className="btn-glass btn-block" disabled={!a.canStartTimeout || a.busy !== null} onClick={a.startTimeout}>
            {a.busy === "Start timeout" ? "Arming…" : "Start timeout"}
          </button>
          <button className="btn-glass btn-block" disabled={!a.canClaimTimeout || a.busy !== null} onClick={a.claimTimeout}>
            {a.busy === "Claim timeout" ? "Claiming…" : "Claim timeout (forfeit)"}
          </button>
        </div>

        {advanced && (
          <>
            <div className="section-title">Fraud proofs (opponent cheated)</div>
            <div className="col">
              {a.canProveT && <button className="btn-warn btn-block" disabled={a.busy !== null} onClick={a.proveT}>{a.busy === "Prove action fork" ? "Proving…" : "Prove fraud — action fork"}</button>}
              {a.canProveI && <button className="btn-warn btn-block" disabled={a.busy !== null} onClick={a.proveI}>{a.busy === "Prove slot fork" ? "Proving…" : "Prove fraud — slot fork"}</button>}
              {a.canProveR && <button className="btn-warn btn-block" disabled={a.busy !== null} onClick={a.proveR}>{a.busy === "Prove random fork" ? "Proving…" : "Prove fraud — random fork"}</button>}
              {a.canProveP && <button className="btn-warn btn-block" disabled={a.busy !== null} onClick={a.proveP}>{a.busy === "Prove wrong parity" ? "Proving…" : "Prove fraud — roll-class lie"}</button>}
            </div>
          </>
        )}

        {dispute && (
          <>
            <div className="section-title">Roll-class dispute</div>
            <div className="col">
              {a.canChallengeRoll && <button className="btn-warn btn-block" disabled={a.busy !== null} onClick={a.challengeRoll}>{a.busy === "Challenge roll" ? "Challenging…" : "Challenge roll — demand evidence for an unseen turn"}</button>}
              {a.canAnswerRoll && <button className="btn-o btn-block" disabled={a.busy !== null} onClick={a.answerRoll}>{a.busy === "Answer roll challenge" ? "Answering…" : "Answer roll challenge — post the ceremony reveals"}</button>}
              {a.canClaimRoll && <button className="btn-warn btn-block" disabled={a.busy !== null} onClick={a.claimRoll}>{a.busy === "Claim roll forfeit" ? "Claiming…" : "Claim forfeit — challenge went unanswered"}</button>}
            </div>
          </>
        )}

        {records.length > 0 && (
          <>
            <div className="section-title">Turn ledger</div>
            <div className="ledger">
              {records.map((r) => (
                <div key={r.turn} style={{ display: "contents" }}>
                  <div className="lk">t{r.turn} {colorOfRole(r.mover)}</div>
                  <div className="lv">
                    {r.action
                      ? r.action.kind === KIND_PLACE ? `place ${SIZE_LABEL[r.action.size]}@c${r.action.cell}`
                        : r.action.kind === KIND_REMOVE ? `remove c${r.action.cell}` : "pass"
                      : "(pending)"}
                    {r.slot !== null ? ` · slot ${r.slot}` : ""}
                    {r.random ? ` · ${shortHex(r.random)}` : ""}
                  </div>
                  <div>
                    {r.turn === 0 ? <span className="tag good">FIRST</span>
                      : r.parity === null ? <span className="tag warn">…</span>
                      : r.parity === 1 ? <span className="tag good">{r.roll}→PLACE</span>
                      : <span className="tag warn">{r.roll}→REMOVE</span>}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {a.error && <div className="error">{a.error}</div>}

        <div className="section-title">&nbsp;</div>
        <button className="btn-glass btn-block" onClick={onLeave}>← Leave to lobby</button>
      </aside>
    </>
  );
}
