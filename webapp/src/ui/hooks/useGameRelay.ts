// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

import { useEffect, useRef, useState } from "react";
import { connectRelay, localRelay, type RelayClient, type WireInbound } from "../../api/ws.ts";
import { colorOfMark, colorOfRole } from "../../game/labels.ts";
import { logEvent } from "../../game/log-store.ts";
import {
  type PlayerSession,
  decodeIntent,
  decodeMove,
  decodeRandomReveal,
  encodeRandomReveal,
} from "../../game/player-session.ts";
import { replayRecoverableMessages } from "../../game/recovery.ts";
import { saveSession } from "../../game/storage.ts";
import { ROLL_MAX } from "../../../../src/sdk/game/rules.ts";
import { fmtAction, shortHex } from "../game-format.ts";

export type RelayRef = { current: RelayClient | null };
export type MessageQueueRef = { current: WireInbound[] };
export type MessageHandlerRef = { current: ((message: WireInbound) => void) | null };

export function useGameRelay(session: PlayerSession, vsAi: boolean, force: () => void) {
  const [wsStatus, setWsStatus] = useState<"connecting" | "open" | "closed">("connecting");
  const relayRef = useRef<RelayClient | null>(null);
  const lastWsRef = useRef<string>("");
  // Relay messages that arrived BEFORE the chain poll delivered the opponent's
  // commitments (intent/random/move all need them). On a hosted network the
  // chain read can lose that race — queue and replay instead of dropping, else
  // the opponent's first roll intent vanishes and the game hangs on "rolling".
  const pendingMsgsRef = useRef<WireInbound[]>([]);
  const handleMsgRef = useRef<((msg: WireInbound) => void) | null>(null);

  useEffect(() => {
    logEvent(`session: role=${colorOfRole(session.role)}, game=${session.gameId.slice(0, 16)}…, local turns=${session.committedTurns}`);
    // Practice vs AI loops through an in-tab channel (no relay server); real
    // multiplayer uses the WebSocket relay.
    const connect = vsAi ? localRelay : connectRelay;
    const onMsg = (msg: WireInbound) => {
      if (msg.type === "joined") logEvent(`peer (${msg.role}) joined`);
      else if (msg.type === "left") logEvent(`peer (${msg.role}) left`);
      else if (msg.type === "event") logEvent(`chain event: ${msg.kind}`);
      // intent/random/move all need the opponent's commitments; until the
      // chain poll delivers them, queue (the poll replays after setOpponent).
      else if (!session.opponentInfo && (msg.type === "intent" || msg.type === "random" || msg.type === "move")) {
        pendingMsgsRef.current.push(msg);
        logEvent(`${msg.type} queued — waiting for opponent commitments from chain`);
      }
      else if (msg.type === "intent") {
        const it = decodeIntent(msg.payload);
        const r = session.receiveIntent(it);
        if (!r.ok) { logEvent(`! intent rejected: ${r.reason}`); force(); return; }
        logEvent(`<- intent turn=${it.turn} slot=${it.slot}`);
        try {
          const reveal = session.respondWithRandom();
          saveSession(session.serialise());
          relayRef.current?.send({ type: "random", addr: session.gameId, payload: encodeRandomReveal(reveal) });
          logEvent(`-> random turn=${reveal.turn} slot=${reveal.slot} value=${shortHex(reveal.random)}`);
        } catch (e) {
          logEvent(`! could not persist/respond with random: ${(e as Error).message}`);
        }
        force();
      }
      else if (msg.type === "random") {
        const rv = decodeRandomReveal(msg.payload);
        const r = session.receiveRandomReveal(rv);
        if (!r.ok) { logEvent(`! random rejected: ${r.reason}`); force(); return; }
        const roll = session.rollForTurn(rv.turn);
        const cls = session.parityForTurn(rv.turn);
        logEvent(`<- random turn=${rv.turn} value=${shortHex(rv.random)} -> roll ${roll}/${ROLL_MAX} = ${cls === 1 ? "PLACE" : "REMOVE"}`);
        try { saveSession(session.serialise()); }
        catch (e) { logEvent(`! ${(e as Error).message}`); }
        force();
      }
      else if (msg.type === "move") {
        const m = decodeMove(msg.payload);
        const r = session.receiveMove(m);
        if (!r.ok) { logEvent(`! received invalid move: ${r.reason}`); force(); return; }
        if (r.duplicate) { logEvent(`<- duplicate move turn=${m.turn} ignored (recovery replay)`); return; }
        logEvent(`<- move turn=${m.turn} ${fmtAction({ kind: m.kind, cell: m.cell, size: m.size })} (${colorOfRole(session.role === "x" ? "o" : "x")})`);
        if (r.status === "ended") logEvent(`local game ended — winner: ${session.winnerLocal === "draw" ? "draw" : colorOfMark(session.winnerLocal as number)}`);
        try { saveSession(session.serialise()); }
        catch (e) { logEvent(`! ${(e as Error).message}`); }
        force();
      }
    };
    handleMsgRef.current = onMsg;
    const client = connect(
      session.gameId,
      session.role,
      onMsg,
      (s) => {
        if (lastWsRef.current !== s) { lastWsRef.current = s; logEvent(`relay: ${s}`); }
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
              if (replayed.length) logEvent(`relay recovery: replayed ${replayed.join(", ")}`);
            } catch (e) {
              logEvent(`! relay recovery paused: ${(e as Error).message}`);
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

  return { wsStatus, relayRef, pendingMsgsRef, handleMsgRef };
}
