// Message-only relay: a dumb WebSocket switchboard for the off-chain ceremony
// (intent / random / move) between the two players sharing a gameId. It holds
// NO wallet, NO contract, and NO Midnight SDK — every on-chain action now runs
// client-side in the browser (see webapp/src/chain/*). It's kept solely because
// two browsers still need a transport to exchange moves; for Practice-vs-AI both
// sides live in one tab but still marshal through here.
//
//   WS /relay     join / intent / random / move / event   (broadcast per room)
//   GET /api/health                                        (liveness only)

const PORT = Number(process.env.RELAY_PORT ?? 4310);
// Abuse caps — a full game is ~128 turns × 3 ceremony messages, so the
// defaults leave generous headroom while keeping a hostile client from
// growing memory without bound.
const MAX_ROOMS = Number(process.env.RELAY_MAX_ROOMS ?? 1000);
const MAX_HISTORY = Number(process.env.RELAY_MAX_HISTORY ?? 1500);
const MAX_MESSAGE_BYTES = Number(process.env.RELAY_MAX_MESSAGE_BYTES ?? 256 * 1024);
const log = (...args: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...args);

// ── Rooms (WS broadcast between two players sharing a gameId). ─────────────
type RoomRole = "x" | "o";
interface RoomClient {
  ws: any;
  role: RoomRole;
}
interface Room {
  clients: Map<RoomRole, RoomClient>;
  history: { type: "intent" | "random" | "move"; payload: unknown }[];
}
const rooms = new Map<string, Room>();
function getRoom(gameId: string): Room | null {
  let r = rooms.get(gameId);
  if (!r) {
    if (rooms.size >= MAX_ROOMS) {
      log("room limit reached — rejecting", gameId.slice(0, 10));
      return null;
    }
    r = { clients: new Map(), history: [] };
    rooms.set(gameId, r);
  }
  return r;
}
function broadcast(room: Room, except: RoomRole | null, payload: object) {
  for (const [role, client] of room.clients) {
    if (except === role) continue;
    try {
      client.ws.send(JSON.stringify(payload));
    } catch (e) {
      log("ws send error:", (e as Error).message);
    }
  }
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}
const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...corsHeaders() } });

// ── Server (WS + a trivial health check). ───────────────────────────────────
const server = Bun.serve({
  port: PORT,
  websocket: {
    maxPayloadLength: MAX_MESSAGE_BYTES,
    open(ws) {
      (ws as any).data = { addr: null, role: null };
    },
    message(ws, message) {
      const raw = String(message);
      if (raw.length > MAX_MESSAGE_BYTES) {
        log("oversized message dropped", raw.length);
        return;
      }
      let msg: any;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      switch (msg.type) {
        case "join": {
          if (typeof msg.addr !== "string" || (msg.role !== "x" && msg.role !== "o")) return;
          const room = getRoom(msg.addr);
          if (!room) {
            try { ws.close(1013, "relay full"); } catch {}
            return;
          }
          if (room.clients.has(msg.role)) {
            try { room.clients.get(msg.role)!.ws.close(); } catch {}
          }
          room.clients.set(msg.role, { ws, role: msg.role });
          (ws as any).data = { addr: msg.addr, role: msg.role };
          log("ws join", msg.addr.slice(0, 10), msg.role, `(room size=${room.clients.size})`);
          for (const m of room.history) {
            try { ws.send(JSON.stringify(m)); } catch {}
          }
          broadcast(room, msg.role, { type: "joined", addr: msg.addr, role: msg.role });
          break;
        }
        case "intent":
        case "random":
        case "move": {
          const { addr, role } = (ws as any).data;
          if (!addr || !role) return;
          const room = getRoom(addr);
          if (!room) return;
          if (room.history.length >= MAX_HISTORY) {
            log("history cap hit — dropping message", addr.slice(0, 10));
            return;
          }
          room.history.push({ type: msg.type, payload: msg.payload });
          log(`ws ${msg.type}`, addr.slice(0, 10), "turn=", msg.payload?.turn, "from=", role);
          broadcast(room, role, { type: msg.type, addr, payload: msg.payload });
          break;
        }
        case "event": {
          const { addr } = (ws as any).data;
          if (!addr) return;
          const room = getRoom(addr);
          if (!room) return;
          broadcast(room, null, { type: "event", addr, kind: msg.kind });
          break;
        }
        case "leave":
          break;
      }
    },
    close(ws) {
      const { addr, role } = (ws as any).data ?? {};
      if (!addr || !role) return;
      const room = rooms.get(addr);
      if (!room) return;
      if (room.clients.get(role)?.ws === ws) {
        room.clients.delete(role);
        log("ws close", addr.slice(0, 10), role, `(room size=${room.clients.size})`);
        broadcast(room, null, { type: "left", addr, role });
        if (room.clients.size === 0) rooms.delete(addr);
      }
    },
  },
  fetch(req: Request) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });
    if (url.pathname === "/relay") {
      const ok = (server as any).upgrade(req);
      return ok ? undefined : new Response("ws upgrade failed", { status: 500 });
    }
    if (url.pathname === "/" || url.pathname === "/api/health") {
      return json({ ok: true, role: "message-relay" });
    }
    return json({ ok: false, error: "not found" }, 404);
  },
});

log(`relay: message-only ws on http://localhost:${PORT}`);
