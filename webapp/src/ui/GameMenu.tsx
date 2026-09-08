// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

// Blockchain-actions drawer — slides in from the top-left hamburger. Holds the
// game's on-chain status + the blockchain actions (settle/redeem). Closes on
// backdrop click, ✕, or Esc.

import { useEffect } from "react";
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
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const wsTag = wsStatus === "open" ? "good" : wsStatus === "connecting" ? "warn" : "bad";
  const localWinner = session.winnerLocal;
  const records = session.turnRecords();
  const a = actions;

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

        {a.busy && a.status && <div className="tx-status">⏳ {a.status}</div>}
        {a.error && <div className="error">{a.error}</div>}

        <div className="section-title">&nbsp;</div>
        <button className="btn-glass btn-block" onClick={onLeave}>← Leave to lobby</button>
      </aside>
    </>
  );
}
