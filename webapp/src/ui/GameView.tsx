// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

import { useState } from "react";
import Board3D from "./Board3D.tsx";
import GameMenu from "./GameMenu.tsx";
import TurnDie from "./TurnDie.tsx";
import { useAiOpponent, useAiThinking } from "./hooks/useAiLifecycle.ts";
import { useChainActions } from "./hooks/useChainActions.ts";
import { useChainPolling, useChainSnapshot, useWinBalance } from "./hooks/useGameChain.ts";
import { useGameActions } from "./hooks/useGameActions.ts";
import { useGameRelay } from "./hooks/useGameRelay.ts";
import { PlayerSession } from "../game/player-session.ts";
import { isVsAi } from "../game/storage.ts";
import { colorOfMark } from "../game/labels.ts";
import { KIND_PASS } from "../../../src/sdk/game/rules.ts";

interface Props {
  session: PlayerSession;
  onLeave: () => void;
}

export default function GameView({ session, onLeave }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [winDismissed, setWinDismissed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [tick, setTick] = useState(0);            // re-render pulse (WS / chain events)
  const force = () => setTick((x) => x + 1);

  const { chain, applyChain, refreshChain } = useChainSnapshot(session);
  const actions = useChainActions(session, chain, refreshChain);
  const vsAi = isVsAi(session.gameId);
  const wins = useWinBalance(chain);
  const { wsStatus, relayRef, pendingMsgsRef, handleMsgRef } = useGameRelay(session, vsAi, force);
  useAiOpponent(session.gameId, vsAi);
  useChainPolling(session, applyChain, force, pendingMsgsRef, handleMsgRef);

  const aiThinking = vsAi && session.turnPhase.phase === "waitOpponent";
  const aiMsg = useAiThinking(aiThinking);
  const {
    phase, selectedSize, setSelectedSize, throwDice, board, reserves, myMark,
    acting, actParity, actionableCells, mode, mustPass, stalledPlace, myDieTarget,
    oppDieTarget, sendMove, onCellClick,
  } = useGameActions(session, relayRef, force, tick);

  // ── Banner ────────────────────────────────────────────────────────────────
  const turnNo = session.currentTurn + 1;                       // 1-indexed for display
  const myColor = <span className={`piece-color ${myMark === 1 ? "x" : "o"}`}>{myMark === 1 ? "RED" : "BLUE"}</span>;
  const banner = (() => {
    switch (phase.phase) {
      case "gameOver":
        return <>Game over — winner: <strong>{String(phase.winner) === "draw" ? "draw" : colorOfMark(phase.winner as number)}</strong>.</>;
      case "waitOpponent":
        return vsAi
          ? <>Turn {turnNo} — <span className="thinking">{aiMsg}</span></>
          : <>Turn {turnNo} — opponent's turn. Waiting…</>;
      case "myIntent":
        return <>Turn {turnNo} — setting up your turn…</>;
      case "awaitRandom":
        return <>Turn {turnNo} — rolling for your turn…</>;
      case "act": {
        if (actParity === 0) {
          return mustPass
            ? <>Turn {turnNo} — it's your turn. Nothing to remove — pass.</>
            : <>Turn {turnNo} — it's your turn. You rolled a <strong>remove</strong> — take any piece off the board (yours or your opponent's).</>;
        }
        if (stalledPlace) return <>Turn {turnNo} — it's your turn, but there's no legal placement. You're stalled.</>;
        return <>Turn {turnNo} — it's your turn. Select a {myColor} piece and place it on the board.</>;
      }
    }
  })();

  // ── Win overlay ─────────────────────────────────────────────────────────────
  const ended = phase.phase === "gameOver";
  const winner = session.winnerLocal;                         // 1 | 2 | "draw"
  const iWon = winner !== "draw" && winner === myMark;
  const winClass = winner === "draw" ? "draw" : winner === 1 ? "x" : "o";
  const headline = winner === "draw" ? "Draw" : iWon ? "You win!" : "You lose";
  const recorded = chain?.status === 2;

  return (
    <div className="stage-root">
      <div className={`board-stage ${acting ? "" : "inactive3d"}`}>
        <Board3D
          board={board}
          reserves={reserves}
          myMark={myMark}
          mode={mode}
          actionableCells={actionableCells}
          selectedSize={selectedSize}
          onSelectSize={setSelectedSize}
          onCellClick={onCellClick}
          active={acting}
        />
      </div>

      <button className="hamburger glass" onClick={() => setMenuOpen(true)} aria-label="Blockchain actions">☰</button>
      <div className="gi-stack">
        <div className="win-token-panel glass" tabIndex={0}>
          <span className="win-token-icon" aria-hidden>🏆</span>
          <span className="win-token-label">Win tokens</span>
          <span className="win-token-count">{wins == null ? "…" : wins}</span>
          <span className="tip">
            These are <strong>tokens</strong> — shielded rewards minted to you when you win.
            They can be traded and viewed in your wallet.
          </span>
        </div>
        <div className="game-info glass">
        <div className="gi-head">
          <span className="gi-label">GAME ID</span>
          {vsAi && <span className="vsai-inline">vs <span className="accent">AI</span></span>}
        </div>
        <button
          className="gi-id"
          title="Copy game id"
          onClick={() => {
            navigator.clipboard?.writeText(session.gameId)
              .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })
              .catch(() => {});
          }}
        >
          <span className="mono">{session.gameId.slice(0, 8)}…{session.gameId.slice(-6)}</span>
          <span className="gi-copy">{copied ? "copied ✓" : "copy"}</span>
        </button>
        {!vsAi && !session.opponentInfo && (
          <p className="gi-invite">
            Send this id to a friend so they can <strong>Join a game</strong> as{" "}
            <span className="piece-color o">BLUE</span>.
          </p>
        )}
        </div>
      </div>

      <div className="board-overlay top">
        <div className="toast glass">{banner}</div>
      </div>

      <TurnDie target={oppDieTarget} side="left" caption={vsAi ? "AI" : "Opponent"} />
      <TurnDie target={myDieTarget} side="right" caption="You" onThrow={throwDice} />

      {mustPass && (
        <div className="modal-overlay">
          <div className="modal-card glass">
            <h2 className="modal-title">No plays available</h2>
            <p className="muted" style={{ margin: "0 0 18px" }}>
              You rolled <strong>even — a remove</strong>, but your opponent has no pieces on the board to take off.
              This turn will be passed.
            </p>
            <button className="btn-o btn-block" onClick={() => sendMove({ kind: KIND_PASS, cell: 0, size: 0 })}>
              OK
            </button>
          </div>
        </div>
      )}

      {ended && !winDismissed && (
        <div className="win-overlay">
          <div className="win-card glass">
            <h2 className={`win-headline ${winClass}`}>{headline}</h2>
            <p className="muted" style={{ margin: "0 0 18px" }}>
              {winner === "draw" ? "No four-in-a-row." : <>Winner: <strong>{colorOfMark(winner as number)}</strong></>}
            </p>
            {recorded ? (
              <>
                <p style={{ margin: "0 0 10px" }}><span className="tag good">Recorded on-chain ✓</span></p>
                {iWon && (
                  <p className="win-token-earned" style={{ margin: "0 0 18px" }}>🏆 You earned a win token!</p>
                )}
                <button className="btn-glass btn-block" onClick={onLeave}>← Back to lobby</button>
              </>
            ) : (
              <div className="col">
                <p className="muted" style={{ margin: "0 0 4px" }}>
                  Record the result on-chain: <strong>Submit</strong> your moves, then{" "}
                  <strong>Redeem</strong> once the challenge window closes.
                  {iWon && <> Winning mints you a 🏆 <strong>win-token</strong>.</>}
                </p>
                <button className="btn-o btn-block" disabled={!actions.canSettle || actions.busy !== null} onClick={actions.settle}>
                  {actions.busy === "Submit" ? "Submitting…" : actions.canSettle ? "Submit result" : "Submitted — wait for window"}
                </button>
                <button className="btn-o btn-block" disabled={!actions.canClaimResult || actions.busy !== null} onClick={actions.claimResult}>
                  {actions.busy === "Redeem" ? "Redeeming…" : iWon ? "Redeem — mint win token 🏆" : "Redeem"}
                </button>
                {actions.busy && actions.status && <div className="tx-status">⏳ {actions.status}</div>}
                {actions.error && <div className="error">{actions.error}</div>}
                <button className="back-link" onClick={() => setWinDismissed(true)}>Hide — view the board</button>
              </div>
            )}
          </div>
        </div>
      )}

      {ended && winDismissed && !recorded && (
        <div className="board-overlay bottom">
          <button className="btn-o btn-sm" onClick={() => setWinDismissed(false)}>🏁 Result — submit / redeem</button>
        </div>
      )}

      <GameMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        session={session}
        chain={chain}
        wsStatus={wsStatus}
        actions={actions}
        onLeave={onLeave}
      />
    </div>
  );
}
