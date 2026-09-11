// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

import {
  encodeIntent,
  encodeMove,
  encodeRandomReveal,
  type PlayerSession,
} from "./player-session.ts";
import type { WireOutbound } from "../api/ws.ts";

// A participant can be ahead by at most one move in the alternating protocol.
// On every relay open, replay that last locally-authored move and the current
// ceremony message. Receivers validate messages and accept identical current
// duplicates, so this repairs a lost final send or relay restart without adding
// a second source of truth. It does not resolve genuinely divergent histories.
export function replayRecoverableMessages(
  session: PlayerSession,
  send: (message: WireOutbound) => void,
  persist: () => void,
): string[] {
  const messages: Array<{ description: string; message: WireOutbound }> = [];
  const replayed: string[] = [];
  const lastMove = session.moves[session.moves.length - 1];
  if (lastMove) {
    const authoredBy = lastMove.turn % 2 === 0 ? "x" : "o";
    if (authoredBy === session.role) {
      messages.push({
        description: `move ${lastMove.turn}`,
        message: { type: "move", addr: session.gameId, payload: encodeMove(lastMove) },
      });
    }
  }

  const phase = session.turnPhase;
  if (phase.phase === "awaitRandom") {
    const intent = session.myIntent();
    messages.push({
      description: `intent ${intent.turn}`,
      message: { type: "intent", addr: session.gameId, payload: encodeIntent(intent) },
    });
  } else if (phase.phase === "waitOpponent") {
    try {
      const reveal = session.respondWithRandom();
      messages.push({
        description: `random ${reveal.turn}`,
        message: { type: "random", addr: session.gameId, payload: encodeRandomReveal(reveal) },
      });
    } catch (error) {
      if ((error as Error).message !== "no opponent intent for this turn") throw error;
    }
  }

  // A normal save may have failed after mutating this in-memory session. Save
  // the complete current state before replaying anything so reconnect can never
  // publish a move or ceremony reveal that the browser cannot recover locally.
  if (messages.length > 0) persist();
  for (const { description, message } of messages) {
    send(message);
    replayed.push(description);
  }

  return replayed;
}
