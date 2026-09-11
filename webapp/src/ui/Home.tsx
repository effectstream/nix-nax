// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

import type { PlayerSession } from "../game/player-session.ts";
import { isVsAi } from "../game/storage.ts";
import { canReconnectSavedGame } from "../game/reconnect.ts";
import { colorOfRole } from "../game/labels.ts";
import Board3D from "./Board3D.tsx";
import { emptyBoard, fullReserves } from "../../../src/sdk/game/rules.ts";
import { useLobbyController } from "./hooks/useLobbyController.ts";

export interface HomeProps {
  onOpen: (session: PlayerSession) => void;
}

const timeAgo = (ms?: number) => {
  if (!ms) return "—";
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

// Underlined glossary term with a hover tooltip.
function Term({ word, tip }: { word: string; tip: string }) {
  return <span className="term">{word}<span className="tip">{tip}</span></span>;
}

export default function Home({ onOpen }: HomeProps) {
  const {
    view, setView, busy, error, setError, joinId, setJoinId, reconId, setReconId,
    reconRole, setReconRole, saved, states, connected, relayUp, gated, newGame,
    joinGame, removeSession, reconnect,
  } = useLobbyController(onOpen);

  return (
    <div className="stage-root">
      <div className="board-stage">
        <Board3D board={emptyBoard()} reserves={fullReserves()} myMark={1} mode="view" active={false} spectator />
      </div>

      <div className="landing">
        <div className="landing-card glass">
          <p className="brand"><span className="x">STACKED</span> 4×4 · MIDNIGHT</p>
          <h1 className="title">Nix-Nax</h1>
          <p className="muted">
            A{" "}
            <Term word="friendly" tip="This simplified contract trusts the two players not to cheat: it still enforces every board rule and checks each move's committed token, but the anti-cheat machinery is left out to keep it readable. The separate advanced reference explores disputes and timeouts, but it has documented protocol limitations and is not presented as trustless." />{" "}
            game implemented in{" "}
            <Term word="Midnight" tip="A privacy-focused blockchain that runs smart contracts with zero-knowledge proofs — keeping data confidential while still publicly verifiable." />{" "}
            with{" "}
            <Term word="ZK Proofs" tip="Zero-knowledge proofs: cryptography that proves a statement is true (e.g. “this move is legal”) without revealing the secret behind it." />.
            <br />
            Four visible tops in a row and you win.
          </p>

          {view === "menu" && (
            <>
              {!connected && (
                <p className="muted" style={{ margin: "0 0 10px", fontSize: 13 }}>
                  🔑 Connect a wallet to play — use the <strong>Wallet</strong> button (top-right).
                </p>
              )}
              {relayUp === false && (
                <p className="muted" style={{ margin: "0 0 10px", fontSize: 13 }}>
                  📡 Multiplayer relay offline — <strong>New game</strong>, <strong>Join</strong> and{" "}
                  <strong>Reconnect</strong> for multiplayer need it. <strong>Practice vs AI</strong> and its saved games run fully in your browser.
                </p>
              )}
              <div className="choices">
                <button className="btn-x" disabled={relayUp === false} onClick={gated(() => newGame(false))}>New game</button>
                <button className="btn-o" disabled={relayUp === false} onClick={gated(() => { setError(null); setView("join"); })}>Join a game</button>
                <button className="btn-glass" onClick={gated(() => newGame(true))}>🤖 Practice vs AI</button>
                <button className="btn-glass" disabled={relayUp === false && !saved.some((entry) => isVsAi(entry.addr))} onClick={gated(() => { setError(null); setView("reconnect"); })}>Reconnect</button>
              </div>
            </>
          )}

          {view === "join" && (
            <div className="col" style={{ marginTop: 8 }}>
              <button className="back-link" onClick={() => setView("menu")}>← back</button>
              <p className="muted" style={{ margin: 0 }}>
                Paste the game id X shared. You generate your own keys and submit them — a tampered game
                fails the join and costs you nothing.
              </p>
              <div className="field">
                <input type="text" value={joinId} onChange={(e) => setJoinId(e.target.value)} placeholder="game id (64 hex chars)" />
                <button className="btn-o" onClick={joinGame} disabled={!joinId.trim()}>Join</button>
              </div>
            </div>
          )}

          {view === "reconnect" && (
            <div className="col" style={{ marginTop: 8 }}>
              <button className="back-link" onClick={() => setView("menu")}>← back</button>
              {saved.length === 0 && <p className="muted" style={{ margin: 0 }}>No saved sessions in this browser yet.</p>}
              <div className="session-list">
                {saved.map((e) => (
                  <div key={e.addr + e.role} className="session">
                    <span className={`role-chip ${e.role}`}>{colorOfRole(e.role)}</span>
                    <div className="meta">
                      <code>{e.addr.slice(0, 14)}…{e.addr.slice(-6)}</code>
                      <div className="sub">{timeAgo(e.updatedAt)} · {states[e.addr] ?? "checking…"}</div>
                    </div>
                    <button className="btn-glass btn-sm" disabled={!canReconnectSavedGame(relayUp, isVsAi(e.addr))} onClick={() => reconnect(e.addr, e.role)}>Resume</button>
                    <button className="btn-glass btn-sm session-del" title="Remove from this browser" onClick={() => removeSession(e.addr, e.role)}>✕</button>
                  </div>
                ))}
              </div>
              <p className="muted" style={{ margin: "8px 0 0" }}>…or reconnect by id:</p>
              <div className="field">
                <input type="text" value={reconId} onChange={(e) => setReconId(e.target.value)} placeholder="game id (64 hex chars)" />
                <div className="seg">
                  <button className={reconRole === "x" ? "active x" : ""} onClick={() => setReconRole("x")}>RED</button>
                  <button className={reconRole === "o" ? "active o" : ""} onClick={() => setReconRole("o")}>BLUE</button>
                </div>
                <button className="btn-glass" onClick={() => reconnect(reconId, reconRole)} disabled={!reconId.trim()}>Resume</button>
              </div>
            </div>
          )}

          {error && <div className="error">{error}</div>}

          <p className="repo-note">
            Check out the full source code at{" "}
            <a href="https://github.com/effectstream/nix-nax" target="_blank" rel="noreferrer">
              github.com/effectstream/nix-nax
            </a>
          </p>
        </div>
      </div>

      {busy && (
        <div className="loading-overlay">
          <div className="loading-card glass">
            <div className="spinner" />
            <div>{busy}</div>
            <div className="muted" style={{ fontSize: 12 }}>This can take a few seconds.</div>
          </div>
        </div>
      )}
    </div>
  );
}
