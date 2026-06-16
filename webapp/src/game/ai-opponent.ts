// Local AI opponent — a headless O PlayerSession that runs in the player's own
// tab so they can practice solo while still playing the real on-chain protocol.
// It owns its own O identity ("wallet" = generated keys + Merkle commitments),
// joins on-chain via the relay (which pays gas), then plays the exact same
// intent → random → move WebSocket ceremony a remote human would. Move choice
// is delegated to the swappable `chooseAction` policy. The human (X) settles the
// finished game — X's session already holds both sides' moves.
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
  type SerializedSession,
} from "./player-session.ts";
import { connectRelay, type RelayClient } from "../api/ws.ts";
import { api } from "../chain/arena.ts";
import { logEvent } from "./log-store.ts";
import { chooseAction } from "./ai-policy.ts";
import { isQuotaError, pruneAiSessions } from "./quota.ts";

const AI_MARK = 2 as const;                       // the AI always plays O / BLUE
const aiKey = (gameId: string) => `ai-o:${gameId}`;
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

  // Restore the AI's O session if we've played this game before, else mint one.
  const raw = localStorage.getItem(aiKey(gameId));
  const session = raw
    ? PlayerSession.restore(JSON.parse(raw) as SerializedSession)
    : new PlayerSession("o", gameId, generatePlayerKeys("o", fromHex(gameId)), null);
  // The serialized session is >1 MB, so storage can fill after a few practice
  // games. On a quota error, evict OTHER games' AI blobs (keeping this one) and
  // retry; if it still won't fit, degrade gracefully — the AI keeps playing this
  // sitting, it just won't survive a page reload.
  const key = aiKey(gameId);
  const persist = () => {
    const data = JSON.stringify(session.serialise());
    try {
      localStorage.setItem(key, data);
      return;
    } catch (e) {
      if (!isQuotaError(e)) throw e;
    }
    const freed = pruneAiSessions(new Set([key]));
    try {
      localStorage.setItem(key, data);
      if (freed) log(`storage was full — cleared ${freed} old practice session(s)`);
    } catch (e) {
      if (!isQuotaError(e)) throw e;
      log("storage full — AI state won't survive a page reload this session");
    }
  };
  if (!raw) persist();

  const send = (type: "intent" | "random" | "move", payload: unknown) =>
    client?.send({ type, addr: gameId, payload } as never);

  // Take a turn (or kick off our ceremony) whenever it's our move.
  const actIfReady = () => {
    if (stopped || !client) return;
    const ph = session.turnPhase;
    if (ph.phase === "myIntent") {
      const it = session.myIntent();
      send("intent", encodeIntent(it));
      log(`intent turn=${it.turn} slot=${it.slot}`);
      persist();
      return;
    }
    if (ph.phase !== "act") return;
    const action = chooseAction(session.boardState, session.reserveState, AI_MARK, ph.parity ?? 1);
    if (!action) { log("stalled — no legal placement"); return; }
    const move = session.myMove(action);
    send("move", encodeMove(move));
    log(`move turn=${move.turn} ${move.kind === 1 ? `place s${move.size}` : move.kind === 2 ? "remove" : "pass"}@c${move.cell}`);
    persist();
  };

  const onMessage = (msg: { type: string; payload?: unknown }) => {
    if (stopped) return;
    if (msg.type === "intent") {
      const r = session.receiveIntent(decodeIntent(msg.payload as never));
      if (!r.ok) { log(`! intent rejected: ${r.reason}`); return; }
      try {
        send("random", encodeRandomReveal(session.respondWithRandom()));
      } catch (e) { log(`! random failed: ${(e as Error).message}`); }
      persist();
    } else if (msg.type === "random") {
      const r = session.receiveRandomReveal(decodeRandomReveal(msg.payload as never));
      if (r.ok) { persist(); actIfReady(); }
      else log(`! random rejected: ${r.reason}`);
    } else if (msg.type === "move") {
      const r = session.receiveMove(decodeMove(msg.payload as never));
      if (r.ok) { persist(); actIfReady(); }
      else log(`! move rejected: ${r.reason}`);
    }
  };

  // Bootstrap: join on-chain if needed, learn X's commitments, then connect WS.
  (async () => {
    try {
      let st = await api.state(gameId);
      if (stopped) return;
      if (st.status === 0) {
        log("joining on-chain…");
        try {
          await api.join({
            gameId,
            idO: hex(session.keys.id),
            rootO: "0x" + session.keys.tokenTree.root.field.toString(16),
            rootIdxO: "0x" + session.keys.indexTree.root.field.toString(16),
            rootRndO: "0x" + session.keys.randomTree.root.field.toString(16),
          });
          log("joined on-chain");
        } catch (e) {
          log(`join failed (may already be joined): ${(e as Error).message}`);
        }
        if (stopped) return;
        st = await api.state(gameId);
      }
      if (stopped) return;
      if (!session.opponentInfo && (BigInt(st.rootX) !== 0n || !fromHex(st.idX).every((b) => b === 0))) {
        session.setOpponent({
          id: fromHex(st.idX),
          rootToken: BigInt(st.rootX),
          rootIdx: BigInt(st.rootIdxX),
          rootRnd: BigInt(st.rootRndX),
        });
        persist();
      }
      if (stopped) return;
      client = connectRelay(gameId, "o", onMessage, (s) => {
        if (s === "open") setTimeout(actIfReady, 300); // in case it's already our turn (replayed history)
      });
    } catch (e) {
      log(`! startup failed: ${(e as Error).message}`);
    }
  })();

  return {
    stop() {
      stopped = true;
      try { client?.close(); } catch { /* noop */ }
    },
  };
}
