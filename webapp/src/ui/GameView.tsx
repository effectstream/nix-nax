import { useEffect, useMemo, useRef, useState } from "react";
import Board3D, { type BoardMode } from "./Board3D.tsx";
import GameMenu from "./GameMenu.tsx";
import TurnDie, { type DieTarget } from "./TurnDie.tsx";
import { useChainActions } from "./useChainActions.ts";
import { api, type ContractState } from "../chain/arena.ts";
import { connectRelay, type RelayClient } from "../api/ws.ts";
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
  const [aiMsg, setAiMsg] = useState<string>(() => nextAiThought());
  const [tick, setTick] = useState(0);            // re-render pulse (WS / chain events)
  const force = () => setTick((x) => x + 1);
  const log = logEvent;

  const relayRef = useRef<RelayClient | null>(null);
  const prevChainRef = useRef<ContractState | null>(null);
  const lastWsRef = useRef<string>("");

  // Single entry point for chain state so every transition is logged (to console).
  const applyChain = (s: ContractState) => {
    const p = prevChainRef.current;
    if (!p) {
      log(`chain: ${s.statusName}, committedTurns=${s.committedTurns}, winner=${s.winnerName}`);
    } else {
      if (p.statusName !== s.statusName) log(`chain: status ${p.statusName} -> ${s.statusName}`);
      if (p.committedTurns !== s.committedTurns) log(`chain: committedTurns ${p.committedTurns} -> ${s.committedTurns}`);
      if (p.winnerName !== s.winnerName) log(`chain: winner -> ${s.winnerName === "x" || s.winnerName === "o" ? colorOfRole(s.winnerName) : s.winnerName.toUpperCase()}`);
      if (!p.hasChallenge && s.hasChallenge) log(`chain: challenge window armed (until ${s.challengeUntil})`);
      if (p.hasChallenge && !s.hasChallenge) log("chain: challenge window cleared");
      if (!p.hasDeadline && s.hasDeadline) log(`chain: timeout deadline armed (until ${s.deadline})`);
      if (p.hasDeadline && !s.hasDeadline) log("chain: timeout deadline cleared");
      if ((p.actionLog?.length ?? 0) !== (s.actionLog?.length ?? 0)) {
        log(`chain: actionLog ${p.actionLog?.length ?? 0} -> ${s.actionLog?.length ?? 0} entries`);
      }
    }
    prevChainRef.current = s;
    setChain(s);
  };
  const refreshChain = () => { api.state(session.gameId).then(applyChain).catch(() => {}); };

  const actions = useChainActions(session, chain, refreshChain);

  // ── Relay wiring ──────────────────────────────────────────────────────────
  useEffect(() => {
    log(`session: role=${colorOfRole(session.role)}, game=${session.gameId.slice(0, 16)}…, local turns=${session.committedTurns}`);
    const client = connectRelay(
      session.gameId,
      session.role,
      (msg) => {
        if (msg.type === "joined") log(`peer (${msg.role}) joined`);
        else if (msg.type === "left") log(`peer (${msg.role}) left`);
        else if (msg.type === "event") log(`chain event: ${msg.kind}`);
        else if (msg.type === "intent") {
          const it = decodeIntent(msg.payload);
          const r = session.receiveIntent(it);
          if (!r.ok) { log(`! intent rejected: ${r.reason}`); force(); return; }
          log(`<- intent turn=${it.turn} slot=${it.slot}`);
          try {
            const reveal = session.respondWithRandom();
            relayRef.current?.send({ type: "random", addr: session.gameId, payload: encodeRandomReveal(reveal) });
            log(`-> random turn=${reveal.turn} slot=${reveal.slot} value=${shortHex(reveal.random)}`);
          } catch (e) {
            log(`! could not respond with random: ${(e as Error).message}`);
          }
          saveSession(session.serialise());
          force();
        }
        else if (msg.type === "random") {
          const rv = decodeRandomReveal(msg.payload);
          const r = session.receiveRandomReveal(rv);
          if (!r.ok) { log(`! random rejected: ${r.reason}`); force(); return; }
          const roll = session.rollForTurn(rv.turn);
          const cls = session.parityForTurn(rv.turn);
          log(`<- random turn=${rv.turn} value=${shortHex(rv.random)} -> roll ${roll}/${ROLL_MAX} = ${cls === 1 ? "PLACE" : "REMOVE"}`);
          saveSession(session.serialise());
          force();
        }
        else if (msg.type === "move") {
          const m = decodeMove(msg.payload);
          const r = session.receiveMove(m);
          if (!r.ok) { log(`! received invalid move: ${r.reason}`); force(); return; }
          log(`<- move turn=${m.turn} ${fmtAction({ kind: m.kind, cell: m.cell, size: m.size })} (${colorOfRole(session.role === "x" ? "o" : "x")})`);
          if (r.status === "ended") log(`local game ended — winner: ${session.winnerLocal === "draw" ? "draw" : colorOfMark(session.winnerLocal as number)}`);
          saveSession(session.serialise());
          force();
        }
      },
      (s) => {
        if (lastWsRef.current !== s) { lastWsRef.current = s; log(`relay: ${s}`); }
        setWsStatus(s);
      },
    );
    relayRef.current = client;
    return () => client.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.gameId, session.role]);

  // ── Local AI opponent (Practice vs AI) — runs O headless in this same tab ─
  const vsAi = isVsAi(session.gameId);
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
            session.setOpponent({
              id: idBytes,
              rootToken,
              rootIdx: BigInt(oppIsX ? s.rootIdxX : s.rootIdxO),
              rootRnd: BigInt(oppIsX ? s.rootRndX : s.rootRndO),
            });
            log(`opponent commitments fetched from chain (${oppIsX ? "RED" : "BLUE"})`);
            force();
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
    const it = session.myIntent();
    relayRef.current.send({ type: "intent", addr: session.gameId, payload: encodeIntent(it) });
    log(`-> intent turn=${it.turn} slot=${it.slot} (you threw the dice)`);
    saveSession(session.serialise());
    force();
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
            : <>Turn {turnNo} — it's your turn. You rolled a <strong>remove</strong> — take one of your opponent's pieces off the board.</>;
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
      {vsAi && <div className="vsai-chip glass">vs <span className="accent">AI</span></div>}

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
                <p style={{ margin: "0 0 18px" }}><span className="tag good">Recorded on-chain ✓</span></p>
                <button className="btn-glass btn-block" onClick={onLeave}>← Back to lobby</button>
              </>
            ) : (
              <div className="col">
                <p className="muted" style={{ margin: "0 0 4px" }}>
                  Record the result on-chain: <strong>Submit</strong> your moves, then <strong>Redeem</strong> once the challenge window closes.
                </p>
                <button className="btn-o btn-block" disabled={!actions.canSettle || actions.busy !== null} onClick={actions.settle}>
                  {actions.busy === "Submit" ? "Submitting…" : actions.canSettle ? "Submit result" : "Submitted — wait for window"}
                </button>
                <button className="btn-o btn-block" disabled={!actions.canClaimResult || actions.busy !== null} onClick={actions.claimResult}>
                  {actions.busy === "Redeem" ? "Redeeming…" : "Redeem"}
                </button>
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
