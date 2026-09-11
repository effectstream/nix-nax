// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

import { useEffect, useMemo, useState } from "react";
import type { RelayRef } from "./useGameRelay.ts";
import { colorOfMark, colorOfRole } from "../../game/labels.ts";
import { logEvent } from "../../game/log-store.ts";
import { encodeIntent, encodeMove, type PlayerSession } from "../../game/player-session.ts";
import { saveSession } from "../../game/storage.ts";
import {
  KIND_PLACE,
  KIND_REMOVE,
  canPlace,
  canRemove,
  reserveIndex,
  type Action,
} from "../../../../src/sdk/game/rules.ts";
import type { BoardMode } from "../Board3D.tsx";
import type { DieTarget } from "../TurnDie.tsx";
import { fmtAction } from "../game-format.ts";

export function useGameActions(session: PlayerSession, relayRef: RelayRef, force: () => void, tick: number) {
  const [selectedSize, setSelectedSize] = useState<number>(0);
  const phase = session.turnPhase;

  // Manual — the player taps their die to roll (no auto-request). Reads the live
  // session phase so a double-tap can't double-send (intent flips us past myIntent).
  const throwDice = () => {
    const ph = session.turnPhase;
    if (ph.phase !== "myIntent" || !session.opponentInfo || !relayRef.current) return;
    try {
      const it = session.myIntent();
      saveSession(session.serialise());
      relayRef.current.send({ type: "intent", addr: session.gameId, payload: encodeIntent(it) });
      logEvent(`-> intent turn=${it.turn} slot=${it.slot} (you threw the dice)`);
      force();
    } catch (e) {
      logEvent(`! could not save/send intent: ${(e as Error).message}`);
    }
  };

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
      logEvent(`-> move turn=${move.turn} ${fmtAction(action)} (${colorOfRole(session.role)})`);
      saveSession(session.serialise());
      relayRef.current?.send({ type: "move", addr: session.gameId, payload: encodeMove(move) });
      if (session.gameStatus === "ended") logEvent(`local game ended — winner: ${session.winnerLocal === "draw" ? "draw" : colorOfMark(session.winnerLocal as number)}`);
      force();
    } catch (e) {
      logEvent(`! ${(e as Error).message}`);
    }
  };

  const onCellClick = (cell: number) => {
    if (placeMode) sendMove({ kind: KIND_PLACE, cell, size: selectedSize });
    else if (removeMode) sendMove({ kind: KIND_REMOVE, cell, size: 0 });
  };

  return {
    phase, selectedSize, setSelectedSize, throwDice, board, reserves, myMark,
    acting, actParity, actionableCells, mode, mustPass, stalledPlace, myDieTarget,
    oppDieTarget, sendMove, onCellClick,
  };
}
