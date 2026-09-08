// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

// Relay WebSocket client. Reconnects with backoff. Single-room (one
// contract address). Carries the three off-chain message types: intent,
// random reveal, and the signed move.

import type { WireIntent, WireRandomReveal, WireSignedMove } from "../game/player-session.ts";

export type WireInbound =
  | { type: "joined"; addr: string; role: "x" | "o" }
  | { type: "left"; addr: string; role: "x" | "o" }
  | { type: "intent"; addr: string; payload: WireIntent }
  | { type: "random"; addr: string; payload: WireRandomReveal }
  | { type: "move"; addr: string; payload: WireSignedMove }
  | { type: "event"; addr: string; kind: string };

export type WireOutbound =
  | { type: "join"; addr: string; role: "x" | "o" }
  | { type: "intent"; addr: string; payload: WireIntent }
  | { type: "random"; addr: string; payload: WireRandomReveal }
  | { type: "move"; addr: string; payload: WireSignedMove }
  | { type: "event"; addr: string; kind: string }
  | { type: "leave"; addr: string };

export interface RelayClient {
  send(m: WireOutbound): void;
  close(): void;
  readonly status: "connecting" | "open" | "closed";
}

export function connectRelay(
  addr: string,
  role: "x" | "o",
  onMessage: (msg: WireInbound) => void,
  onStatus: (status: "connecting" | "open" | "closed") => void,
): RelayClient {
  let ws: WebSocket | null = null;
  let status: "connecting" | "open" | "closed" = "connecting";
  let intentionallyClosed = false;
  let backoff = 500;
  let generation = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const queue: WireOutbound[] = [];

  const setStatus = (s: typeof status) => {
    status = s;
    onStatus(s);
  };

  const open = () => {
    if (intentionallyClosed) return;
    const openGeneration = ++generation;
    setStatus("connecting");
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${proto}://${window.location.host}/relay`);
    ws = socket;
    socket.addEventListener("open", () => {
      if (intentionallyClosed || openGeneration !== generation || ws !== socket) {
        try { socket.close(); } catch { /* noop */ }
        return;
      }
      setStatus("open");
      backoff = 500;
      socket.send(JSON.stringify({ type: "join", addr, role } satisfies WireOutbound));
      while (queue.length) socket.send(JSON.stringify(queue.shift()!));
    });
    socket.addEventListener("message", (ev) => {
      if (intentionallyClosed || openGeneration !== generation || ws !== socket) return;
      try {
        onMessage(JSON.parse(String(ev.data)) as WireInbound);
      } catch (e) {
        console.warn("ws parse error", e);
      }
    });
    socket.addEventListener("close", () => {
      if (openGeneration !== generation || ws !== socket) return;
      setStatus("closed");
      if (intentionallyClosed) return;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        open();
      }, backoff);
      backoff = Math.min(backoff * 2, 5000);
    });
    socket.addEventListener("error", () => {
      if (openGeneration !== generation || ws !== socket) return;
      try { socket.close(); } catch { /* noop */ }
    });
  };
  open();

  return {
    send(m: WireOutbound) {
      if (intentionallyClosed) return;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(m));
      } else {
        queue.push(m);
      }
    },
    close() {
      if (intentionallyClosed) return;
      intentionallyClosed = true;
      generation++;
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
      queue.length = 0;
      try { ws?.close(); } catch {}
      ws = null;
      setStatus("closed");
    },
    get status() { return status; },
  };
}

// ── In-tab loopback "relay" for Practice vs AI ───────────────────────────────
// No server needed: the human (X) and the local AI (O) exchange the off-chain
// ceremony messages through an in-memory room within the SAME tab. Same
// RelayClient shape as connectRelay, so callers swap it in unchanged. Delivery
// is async (mimics a round-trip) to avoid re-entrant sends mid session-update.

type LocalEndpoint = {
  role: "x" | "o";
  onMessage: (m: WireInbound) => void;
  closed: boolean;
  deliveries: Set<ReturnType<typeof setTimeout>>;
};
type LocalRoom = { endpoints: Set<LocalEndpoint>; history: WireInbound[] };
const localRooms = new Map<string, LocalRoom>();

export function localRelay(
  addr: string,
  role: "x" | "o",
  onMessage: (msg: WireInbound) => void,
  onStatus: (status: "connecting" | "open" | "closed") => void,
): RelayClient {
  let status: "connecting" | "open" | "closed" = "connecting";
  const ep: LocalEndpoint = { role, onMessage, closed: false, deliveries: new Set() };
  let room = localRooms.get(addr);
  if (!room) { room = { endpoints: new Set(), history: [] }; localRooms.set(addr, room); }
  room.endpoints.add(ep);

  const deliver = (to: LocalEndpoint, msg: WireInbound) => {
    if (to.closed) return;
    const timer = setTimeout(() => {
      to.deliveries.delete(timer);
      if (!to.closed) to.onMessage(msg);
    }, 0);
    to.deliveries.add(timer);
  };

  // Replay the room's prior ceremony messages to the newcomer, THEN tell existing
  // peers it joined — exactly like relay/server.ts. Without this, the side that
  // registers late (the AI only connects after its ~20s on-chain join) misses the
  // moves already broadcast and waits forever for a turn that already happened.
  for (const m of room.history) deliver(ep, m);
  for (const other of room.endpoints) {
    if (other !== ep) deliver(other, { type: "joined", addr, role });
  }
  const opened = setTimeout(() => {
    ep.deliveries.delete(opened);
    if (ep.closed) return;
    status = "open";
    onStatus("open");
  }, 0);
  ep.deliveries.add(opened);

  return {
    send(m: WireOutbound) {
      if (ep.closed) return;
      if (m.type === "join" || m.type === "leave") return; // membership handled locally
      const r = localRooms.get(addr);
      if (!r) return;
      const inbound = { ...m, addr } as unknown as WireInbound;
      if (m.type === "intent" || m.type === "random" || m.type === "move") r.history.push(inbound);
      for (const other of r.endpoints) {
        if (other !== ep) deliver(other, inbound);
      }
    },
    close() {
      if (ep.closed) return;
      ep.closed = true;
      for (const timer of ep.deliveries) clearTimeout(timer);
      ep.deliveries.clear();
      const r = localRooms.get(addr);
      if (r) {
        r.endpoints.delete(ep);
        for (const other of r.endpoints) deliver(other, { type: "left", addr, role });
        if (r.endpoints.size === 0) localRooms.delete(addr);
      }
      status = "closed";
      onStatus("closed");
    },
    get status() { return status; },
  };
}

// Probe the relay WS once — the lobby uses this to decide whether the multiplayer
// modes (New game / Join / Reconnect) are available. Resolves true if /relay
// opens, false on error or timeout (e.g. a static deploy with no relay server).
export function pingRelay(timeoutMs = 4000): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean, ws?: WebSocket) => {
      if (done) return;
      done = true;
      try { ws?.close(); } catch { /* noop */ }
      resolve(ok);
    };
    try {
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${window.location.host}/relay`);
      const t = setTimeout(() => finish(false, ws), timeoutMs);
      ws.addEventListener("open", () => { clearTimeout(t); finish(true, ws); });
      ws.addEventListener("error", () => { clearTimeout(t); finish(false, ws); });
    } catch {
      finish(false);
    }
  });
}
