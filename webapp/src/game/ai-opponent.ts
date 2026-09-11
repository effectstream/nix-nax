// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

// Local AI opponent — a headless O PlayerSession that runs in the player's own
// tab so they can practice solo while still playing the real on-chain protocol.
// It owns its own O identity ("wallet" = generated keys + Merkle commitments),
// submits its join through the active browser wallet, then plays the same
// intent → random → move ceremony a remote human would through the in-tab relay.
// Move choice is delegated to the swappable `chooseAction` policy. The human
// (X) settles the finished game — X's session already holds both sides' moves.
//
// Productized from dev/ghost-o.ts. Started/stopped by GameView's useAiOpponent.

import {
  PlayerSession,
  generatePlayerKeys,
  decodeIntent,
  decodeRandomReveal,
  decodeMove,
  encodeIntent,
  encodeRandomReveal,
  encodeMove,
} from "./player-session.ts";
import { localRelay, type RelayClient } from "../api/ws.ts";
import { api } from "../chain/arena.ts";
import { logEvent } from "./log-store.ts";
import { chooseAction } from "./ai-policy.ts";
import { loadAiSession, saveAiSession } from "./storage.ts";
import { replayRecoverableMessages } from "./recovery.ts";

const AI_MARK = 2 as const;                       // the AI always plays O / BLUE
const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (s: string) =>
  new Uint8Array(((s.startsWith("0x") ? s.slice(2) : s).match(/.{1,2}/g) ?? []).map((b) => parseInt(b, 16)));

export interface AiHandle {
  stop(): void;
}

// Start (or resume) the AI as O for `gameId`. Returns a handle to stop it.
export function startAiOpponent(gameId: string): AiHandle {
  let stopped = false;
  let client: RelayClient | null = null;
  const log = (m: string) => logEvent(`AI(BLUE): ${m}`);

  // The AI's O session is created in the async bootstrap below, NOT here: the
  // first-run key generation builds three 128-turn Merkle trees (~10-20s of
  // synchronous crypto) and would freeze the just-mounted game view black.
  let session: PlayerSession | null = null;
  const persist = () => {
    if (!session) return;
    saveAiSession(gameId, session.serialise());
  };
  const persistProgress = (): boolean => {
    try {
      persist();
      return true;
    } catch (e) {
      log(`! ${(e as Error).message} The AI paused to avoid losing resumable state.`);
      return false;
    }
  };
  const send = (type: "intent" | "random" | "move", payload: unknown) =>
    client?.send({ type, addr: gameId, payload } as never);

  // Take a turn (or kick off our ceremony) whenever it's our move.
  const actIfReady = () => {
    if (stopped || !client || !session) return;
    const ph = session.turnPhase;
    if (ph.phase === "myIntent") {
      const it = session.myIntent();
      if (!persistProgress()) return;
      send("intent", encodeIntent(it));
      log(`intent turn=${it.turn} slot=${it.slot}`);
      return;
    }
    if (ph.phase === "awaitRandom") {
      // Intent already sent but no reveal — the send may have been lost (the
      // human's side had no commitments yet, or a reload dropped the in-tab
      // relay history). myIntent() is idempotent (same stored leaf reveal) and
      // receiveIntent accepts identical duplicates, so re-send to self-heal.
      const it = session.myIntent();
      if (!persistProgress()) return;
      send("intent", encodeIntent(it));
      log(`re-sent intent turn=${it.turn} slot=${it.slot} (still waiting for the random reveal)`);
      return;
    }
    if (ph.phase !== "act") return;
    const action = chooseAction(session.boardState, session.reserveState, AI_MARK, ph.parity ?? 1);
    if (!action) { log("stalled — no legal placement"); return; }
    const move = session.myMove(action);
    if (!persistProgress()) return;
    send("move", encodeMove(move));
    log(`move turn=${move.turn} ${move.kind === 1 ? `place s${move.size}` : move.kind === 2 ? "remove" : "pass"}@c${move.cell}`);
  };

  const onMessage = (msg: { type: string; payload?: unknown }) => {
    if (stopped || !session) return;
    if (msg.type === "intent") {
      const r = session.receiveIntent(decodeIntent(msg.payload as never));
      if (!r.ok) { log(`! intent rejected: ${r.reason}`); return; }
      try {
        const reveal = session.respondWithRandom();
        if (!persistProgress()) return;
        send("random", encodeRandomReveal(reveal));
      } catch (e) { log(`! random failed: ${(e as Error).message}`); }
    } else if (msg.type === "random") {
      const r = session.receiveRandomReveal(decodeRandomReveal(msg.payload as never));
      if (r.ok) { if (persistProgress()) actIfReady(); }
      else log(`! random rejected: ${r.reason}`);
    } else if (msg.type === "move") {
      const r = session.receiveMove(decodeMove(msg.payload as never));
      if (r.ok) { if (persistProgress()) actIfReady(); }
      else log(`! move rejected: ${r.reason}`);
    }
  };

  // Bootstrap: mint/restore the O session, join on-chain if needed, learn X's
  // commitments, then connect WS.
  (async () => {
    try {
      // Let the just-mounted game view PAINT before the synchronous Merkle-tree
      // build freezes the main thread — without this the player stares at a
      // black screen for the whole key generation.
      await new Promise((r) => setTimeout(r, 120));
      if (stopped) return;
      const stored = loadAiSession(gameId);
      if (stored) {
        session = PlayerSession.restore(stored);
      } else {
        log("generating keys (three Merkle trees) — the board may freeze for a few seconds…");
        await new Promise((r) => setTimeout(r, 50)); // flush the log/paint first
        session = new PlayerSession("o", gameId, generatePlayerKeys("o", fromHex(gameId)), null);
        // This write is mandatory: never join the chain with an AI identity that
        // cannot be resumed after a reload.
        persist();
        log("keys ready");
      }
      if (stopped) return;
      let st = await api.state(gameId);
      if (stopped) return;
      if (st.status === 0) {
        log("joining on-chain…");
        // Joining right after createGame can be rejected when the wallet
        // balances against a dust set that hasn't ingested the create tx yet
        // (same flake the e2e driver retries — DustDoubleSpend class). Retry
        // with a pause, re-checking the chain between attempts.
        for (let attempt = 1; attempt <= 4; attempt++) {
          try {
            await api.join({
              gameId,
              idO: hex(session.keys.id),
              rootO: "0x" + session.keys.tokenTree.root.field.toString(16),
            });
            log("joined on-chain");
            break;
          } catch (e) {
            if (stopped) return;
            st = await api.state(gameId);
            if (st.status !== 0) { log("join landed on-chain after all"); break; }
            if (attempt === 4) {
              log(`! join failed after ${attempt} attempts — the game cannot proceed on-chain: ${(e as Error).message}`);
              return;
            }
            log(`join rejected (attempt ${attempt}/4) — retrying in 30s: ${(e as Error).message}`);
            await new Promise((r) => setTimeout(r, 30_000));
            if (stopped) return;
          }
        }
        if (stopped) return;
        st = await api.state(gameId);
      }
      if (stopped) return;
      if (!session.opponentInfo && (BigInt(st.rootX) !== 0n || !fromHex(st.idX).every((b) => b === 0))) {
        session.setOpponent({ id: fromHex(st.idX), rootToken: BigInt(st.rootX) });
        persist();
      }
      if (stopped) return;
      client = localRelay(gameId, "o", onMessage, (s) => {
        if (s === "open") {
          setTimeout(() => {
            if (stopped || !client || !session) return;
            try {
              replayRecoverableMessages(session, (message) => client?.send(message), persist);
              actIfReady();
            } catch (e) {
              log(`! relay recovery paused: ${(e as Error).message}`);
            }
          }, 300);
        }
      });
    } catch (e) {
      log(`! startup failed: ${(e as Error).message}`);
    }
  })();

  // Self-heal nudge: if we're stuck waiting for the opponent's random reveal,
  // periodically re-send the intent (idempotent) — covers a reveal lost to the
  // commitments race or a reload that dropped the in-tab relay history.
  const nudge = setInterval(() => {
    if (!stopped && client && session?.turnPhase.phase === "awaitRandom") actIfReady();
  }, 20_000);

  return {
    stop() {
      stopped = true;
      clearInterval(nudge);
      try { client?.close(); } catch { /* noop */ }
    },
  };
}
