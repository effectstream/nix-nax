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
  const queue: WireOutbound[] = [];

  const setStatus = (s: typeof status) => {
    status = s;
    onStatus(s);
  };

  const open = () => {
    setStatus("connecting");
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${window.location.host}/relay`);
    ws.addEventListener("open", () => {
      setStatus("open");
      backoff = 500;
      ws!.send(JSON.stringify({ type: "join", addr, role } satisfies WireOutbound));
      while (queue.length) ws!.send(JSON.stringify(queue.shift()!));
    });
    ws.addEventListener("message", (ev) => {
      try {
        onMessage(JSON.parse(String(ev.data)) as WireInbound);
      } catch (e) {
        console.warn("ws parse error", e);
      }
    });
    ws.addEventListener("close", () => {
      setStatus("closed");
      if (intentionallyClosed) return;
      setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, 5000);
    });
    ws.addEventListener("error", () => {
      try { ws?.close(); } catch {}
    });
  };
  open();

  return {
    send(m: WireOutbound) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(m));
      } else {
        queue.push(m);
      }
    },
    close() {
      intentionallyClosed = true;
      try { ws?.close(); } catch {}
      setStatus("closed");
    },
    get status() { return status; },
  };
}
