// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

import { useEffect, useMemo, useRef, useState } from "react";
import Board3D, { type BoardMode } from "./Board3D.tsx";
import GameMenu from "./GameMenu.tsx";
import TurnDie, { type DieTarget } from "./TurnDie.tsx";
import { useChainActions } from "./useChainActions.ts";
import { api, readWinBalance, type ContractState } from "../chain/arena.ts";
import { connectRelay, localRelay, type RelayClient } from "../api/ws.ts";
import {
  PlayerSession,
  decodeIntent,
  decodeRandomReveal,
  decodeMove,
  encodeIntent,
  encodeRandomReveal,
  encodeMove,
} from "../game/player-session.ts";
import { saveSession, isVsAi } from "../game/storage.ts";
import { startAiOpponent } from "../game/ai-opponent.ts";
import { replayRecoverableMessages } from "../game/recovery.ts";
import { nextAiThought } from "../game/ai-flavor.ts";
import { logEvent } from "../game/log-store.ts";
import { colorOfMark, colorOfRole } from "../game/labels.ts";
import {
  KIND_PLACE,
  KIND_REMOVE,
  KIND_PASS,
  ROLL_MAX,
  canPlace,
  canRemove,
  reserveIndex,
  type Action,
} from "../../../src/sdk/game/rules.ts";

const hexToBytes = (s: string): Uint8Array => {
  const h = (s.startsWith("0x") ? s.slice(2) : s).match(/.{1,2}/g) ?? [];
  return new Uint8Array(h.map((b) => parseInt(b, 16)));
};
const shortHex = (b: Uint8Array): string => {
  const h = Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}…${h.slice(-8)}`;
};
const fmtAction = (a: Action): string =>
  a.kind === KIND_PLACE ? `place s${a.size}@c${a.cell}`
  : a.kind === KIND_REMOVE ? `remove @c${a.cell}`
  : "pass";

interface Props {
  session: PlayerSession;
  onLeave: () => void;
}

export default function GameView({ session, onLeave }: Props) {
  const [chain, setChain] = useState<ContractState | null>(null);
  const [wsStatus, setWsStatus] = useState<"connecting" | "open" | "closed">("connecting");
  const [selectedSize, setSelectedSize] = useState<number>(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [winDismissed, setWinDismissed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [wins, setWins] = useState<number | null>(null);
  const [aiMsg, setAiMsg] = useState<string>(() => nextAiThought());
  const [tick, setTick] = useState(0);            // re-render pulse (WS / chain events)
  const force = () => setTick((x) => x + 1);
  const log = logEvent;

  const relayRef = useRef<RelayClient | null>(null);
  const prevChainRef = useRef<ContractState | null>(null);
  const lastWsRef = useRef<string>("");
  // Relay messages that arrived BEFORE the chain poll delivered the opponent's
  // commitments (intent/random/move all need them). On a hosted network the
  // chain read can lose that race — queue and replay instead of dropping, else
  // the opponent's first roll intent vanishes and the game hangs on "rolling".
  const pendingMsgsRef = useRef<unknown[]>([]);
  const handleMsgRef = useRef<((msg: any) => void) | null>(null);

  // Single entry point for chain state so every transition is logged (to console).
  const applyChain = (s: ContractState) => {
    const p = prevChainRef.current;
    if (!p) {
      log(`chain: ${s.statusName}, committedTurns=${s.committedTurns}, winner=${s.winnerName}`);
    } else {
      if (p.statusName !== s.statusName) log(`chain: status ${p.statusName} -> ${s.statusName}`);
      if (p.committedTurns !== s.committedTurns) log(`chain: committedTurns ${p.committedTurns} -> ${s.committedTurns}`);
      if (p.winnerName !== s.winnerName) log(`chain: winner -> ${s.winnerName === "x" || s.winnerName === "o" ? colorOfRole(s.winnerName) : s.winnerName.toUpperCase()}`);
      if ((p.actionLog?.length ?? 0) !== (s.actionLog?.length ?? 0)) {
        log(`chain: actionLog ${p.actionLog?.length ?? 0} -> ${s.actionLog?.length ?? 0} entries`);
      }
    }
    prevChainRef.current = s;
    setChain(s);
  };
  const refreshChain = () => { api.state(session.gameId).then(applyChain).catch(() => {}); };

  const actions = useChainActions(session, chain, refreshChain);
  const vsAi = isVsAi(session.gameId);

  // Win-token balance (your wins) — shown in the game-info panel. Re-read on
  // mount and whenever the on-chain status changes (e.g. after Redeem mints one).
  useEffect(() => {
    void readWinBalance().then(setWins).catch(() => {});
  }, [chain?.status]);

  // ── Relay wiring ──────────────────────────────────────────────────────────
  useEffect(() => {
    log(`session: role=${colorOfRole(session.role)}, game=${session.gameId.slice(0, 16)}…, local turns=${session.committedTurns}`);
    // Practice vs AI loops through an in-tab channel (no relay server); real
    // multiplayer uses the WebSocket relay.
    const connect = vsAi ? localRelay : connectRelay;
    const onMsg = (msg: any) => {
        if (msg.type === "joined") log(`peer (${msg.role}) joined`);
        else if (msg.type === "left") log(`peer (${msg.role}) left`);
        else if (msg.type === "event") log(`chain event: ${msg.kind}`);
        // intent/random/move all need the opponent's commitments; until the
        // chain poll delivers them, queue (the poll replays after setOpponent).
        else if (!session.opponentInfo && (msg.type === "intent" || msg.type === "random" || msg.type === "move")) {
          pendingMsgsRef.current.push(msg);
          log(`${msg.type} queued — waiting for opponent commitments from chain`);
        }
        else if (msg.type === "intent") {
          const it = decodeIntent(msg.payload);
          const r = session.receiveIntent(it);
          if (!r.ok) { log(`! intent rejected: ${r.reason}`); force(); return; }
          log(`<- intent turn=${it.turn} slot=${it.slot}`);
          try {
            const reveal = session.respondWithRandom();
            saveSession(session.serialise());
            relayRef.current?.send({ type: "random", addr: session.gameId, payload: encodeRandomReveal(reveal) });
            log(`-> random turn=${reveal.turn} slot=${reveal.slot} value=${shortHex(reveal.random)}`);
          } catch (e) {
            log(`! could not persist/respond with random: ${(e as Error).message}`);
          }
          force();
        }
        else if (msg.type === "random") {
          const rv = decodeRandomReveal(msg.payload);
          const r = session.receiveRandomReveal(rv);
          if (!r.ok) { log(`! random rejected: ${r.reason}`); force(); return; }
          const roll = session.rollForTurn(rv.turn);
          const cls = session.parityForTurn(rv.turn);
          log(`<- random turn=${rv.turn} value=${shortHex(rv.random)} -> roll ${roll}/${ROLL_MAX} = ${cls === 1 ? "PLACE" : "REMOVE"}`);
          try { saveSession(session.serialise()); }
          catch (e) { log(`! ${(e as Error).message}`); }
          force();
        }
        else if (msg.type === "move") {
          const m = decodeMove(msg.payload);
          const r = session.receiveMove(m);
          if (!r.ok) { log(`! received invalid move: ${r.reason}`); force(); return; }
          if (r.duplicate) { log(`<- duplicate move turn=${m.turn} ignored (recovery replay)`); return; }
          log(`<- move turn=${m.turn} ${fmtAction({ kind: m.kind, cell: m.cell, size: m.size })} (${colorOfRole(session.role === "x" ? "o" : "x")})`);
          if (r.status === "ended") log(`local game ended — winner: ${session.winnerLocal === "draw" ? "draw" : colorOfMark(session.winnerLocal as number)}`);
          try { saveSession(session.serialise()); }
          catch (e) { log(`! ${(e as Error).message}`); }
          force();
        }
    };
    handleMsgRef.current = onMsg;
    const client = connect(
      session.gameId,
      session.role,
      onMsg,
      (s) => {
        if (lastWsRef.current !== s) { lastWsRef.current = s; log(`relay: ${s}`); }
        setWsStatus(s);
        if (s === "open") {
          setTimeout(() => {
            if (relayRef.current !== client || client.status !== "open") return;
            try {
              const replayed = replayRecoverableMessages(
                session,
                (message) => client.send(message),
                () => saveSession(session.serialise()),
              );
              if (replayed.length) log(`relay recovery: replayed ${replayed.join(", ")}`);
            } catch (e) {
              log(`! relay recovery paused: ${(e as Error).message}`);
            }
          }, 0);
        }
      },
    );
    relayRef.current = client;
    return () => {
      handleMsgRef.current = null;
      if (relayRef.current === client) relayRef.current = null;
      client.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.gameId, session.role]);

  // ── Local AI opponent (Practice vs AI) — runs O headless in this same tab ─
  useEffect(() => {
    if (!vsAi) return;
    const ai = startAiOpponent(session.gameId);
    return () => ai.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.gameId, vsAi]);

  // ── Chain polling (also fills opponent commitments after join) ───────────
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
            log(`opponent commitment fetched from chain (${oppIsX ? "RED" : "BLUE"})`);
            force();
            // Replay relay messages that raced ahead of the commitments (in
            // arrival order) — without this the opponent's first roll intent is
            // dropped and the game hangs on "rolling".
            const queued = pendingMsgsRef.current.splice(0);
            if (queued.length) log(`replaying ${queued.length} queued relay message(s)`);
            for (const m of queued) handleMsgRef.current?.(m);
          }
        }
      } catch (e) {
        if (running) log(`! state poll error: ${(e as Error).message}`);
      }
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => { running = false; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.gameId]);

  // ── Throw the dice: send my intent (asks the opponent for their random) ────
  // Manual — the player taps their die to roll (no auto-request). Reads the live
  // session phase so a double-tap can't double-send (intent flips us past myIntent).
  const phase = session.turnPhase;
  const throwDice = () => {
    const ph = session.turnPhase;
    if (ph.phase !== "myIntent" || !session.opponentInfo || !relayRef.current) return;
    try {
      const it = session.myIntent();
      saveSession(session.serialise());
      relayRef.current.send({ type: "intent", addr: session.gameId, payload: encodeIntent(it) });
      log(`-> intent turn=${it.turn} slot=${it.slot} (you threw the dice)`);
      force();
    } catch (e) {
      log(`! could not save/send intent: ${(e as Error).message}`);
    }
  };

  // ── AI "thinking" copy — rotate while the local AI computes its move ───────
  const aiThinking = vsAi && phase.phase === "waitOpponent";
  useEffect(() => {
    if (!aiThinking) return;
    setAiMsg((m) => nextAiThought(m));
    const id = setInterval(() => setAiMsg((m) => nextAiThought(m)), 2200);
    return () => clearInterval(id);
  }, [aiThinking]);

  // ── Acting ────────────────────────────────────────────────────────────────
  const board = session.boardState;
  const reserves = session.reserveState;
  const myMark = session.myMark;

  useEffect(() => {
    if (reserves[reserveIndex(myMark, selectedSize)] === 0) {
      for (let s = 0; s < 4; s++) {
        if (reserves[reserveIndex(myMark, s)] > 0) { setSelectedSize(s); break; }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  const acting = phase.phase === "act";
  const actParity = acting ? (phase as { parity: 0 | 1 | null }).parity : null;
  const placeMode = acting && (actParity === null || actParity === 1);
  const removeMode = acting && actParity === 0;

  const actionableCells = useMemo(() => {
    const set = new Set<number>();
    if (placeMode) {
      for (let c = 0; c < 16; c++) if (canPlace(board, reserves, myMark, selectedSize, c)) set.add(c);
    } else if (removeMode) {
      for (let c = 0; c < 16; c++) if (canRemove(board, myMark, c)) set.add(c);
    }
    return set;
  }, [placeMode, removeMode, selectedSize, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  const mode: BoardMode = placeMode ? "place" : removeMode ? "remove" : "view";
  const mustPass = removeMode && actionableCells.size === 0;
  const stalledPlace = placeMode && actParity === 1 && actionableCells.size === 0
    && !session.legalPlacementExists();

  // My die (bottom-right): "ready" to tap on a roll turn → "rolling" once I've
  // thrown → lands on Play (odd) / Remove (even). Turn 0 is a forced place (no roll).
  const myDieTarget: DieTarget =
    phase.phase === "act" ? (actParity === 0 ? "remove" : "play")
    : phase.phase === "awaitRandom" ? "rolling"
    : phase.phase === "myIntent" ? "ready"
    : null;

  // Opponent die (bottom-left): shown on their turn — "rolling" until I've seen
  // their intent and answered with my random, then it lands on their result.
  const oppDieTarget: DieTarget = (() => {
    if (phase.phase !== "waitOpponent") return null;
    const t = session.currentTurn;
    const p = t === 0 ? 1 : session.parityForTurn(t);   // turn 0 is a forced place
    return p === null ? "rolling" : p === 0 ? "remove" : "play";
  })();

  const sendMove = (action: Action) => {
    try {
      const move = session.myMove(action);
      log(`-> move turn=${move.turn} ${fmtAction(action)} (${colorOfRole(session.role)})`);
      saveSession(session.serialise());
      relayRef.current?.send({ type: "move", addr: session.gameId, payload: encodeMove(move) });
      if (session.gameStatus === "ended") log(`local game ended — winner: ${session.winnerLocal === "draw" ? "draw" : colorOfMark(session.winnerLocal as number)}`);
      force();
    } catch (e) {
      log(`! ${(e as Error).message}`);
    }
  };

  const onCellClick = (cell: number) => {
    if (placeMode) sendMove({ kind: KIND_PLACE, cell, size: selectedSize });
    else if (removeMode) sendMove({ kind: KIND_REMOVE, cell, size: 0 });
  };

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
