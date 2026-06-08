// Tic-tac-toe relay + thin chain backend.
//
//   HTTP (REST/JSON):  on-chain actions (deploy / settle / dispute / read state)
//   WS  (per-room):    off-chain SignedMove exchange between the two players
//
// The relay holds ONE genesis-funded wallet at startup and reuses it for
// every contract call (the contract distinguishes players cryptographically,
// not by wallet identity). Players' identity secrets live in their browsers.

import { buildAndFundWallet, type WalletBundle } from "../src/sdk/wallet.ts";
import { NETWORK } from "../src/sdk/env.ts";
import { attachTicTacToe, deployTicTacToe, joinChannelCall, readLedger } from "../src/sdk/deploy.ts";
import { createTicTacToePrivateState } from "../src/contract/witnesses.ts";
import { Status, Winner } from "../src/contract/managed/contract/index.js";

const PORT = Number(process.env.RELAY_PORT ?? 4310);
const log = (...args: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...args);

// ── Boot: build the shared wallet once. ───────────────────────────────────

log("relay: booting; waiting for stack and wallet…");
const wallet: WalletBundle = await buildAndFundWallet(
  NETWORK,
  process.env.MIDNIGHT_WALLET_SEED ??
    "0000000000000000000000000000000000000000000000000000000000000001",
);
log("relay: wallet ready");

// ── Per-contract serialisation: prevents two concurrent calls from racing
//    the wallet nonce / contract state.
const queues = new Map<string, Promise<unknown>>();
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  // Keep the chain alive without propagating rejections into the queue —
  // otherwise a failed circuit call leaves an unhandled rejection that
  // takes the process down. The route handler awaits `next` directly and
  // surfaces the error via its own try/catch.
  const guarded = next.catch(() => undefined);
  guarded.then(() => {
    if (queues.get(key) === guarded) queues.delete(key);
  });
  queues.set(key, guarded);
  return next;
}

// Belt-and-braces: any unhandled rejection from the SDK's internals (e.g.
// graphql-ws sockets) should NOT crash the relay.
process.on("unhandledRejection", (reason) => {
  console.error("[relay] unhandledRejection:", reason instanceof Error ? reason.message : reason);
});
process.on("uncaughtException", (err) => {
  console.error("[relay] uncaughtException:", err.message);
});

// ── Codecs (browser-friendly JSON ↔ runtime types). ────────────────────────

const fromHex = (s: string): Uint8Array => {
  const h = (s.startsWith("0x") ? s.slice(2) : s).match(/.{1,2}/g) ?? [];
  return new Uint8Array(h.map((b) => parseInt(b, 16)));
};
const toHex = (b: Uint8Array): string =>
  Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const fieldBig = (v: string | number | bigint): bigint => BigInt(v);

type WirePathEntry = { sibling: string; goes_left: boolean };
type WirePath = { leaf: string; path: WirePathEntry[] };

function decodePath(p: WirePath): { leaf: Uint8Array; path: { sibling: { field: bigint }; goes_left: boolean }[] } {
  return {
    leaf: fromHex(p.leaf),
    path: p.path.map((e) => ({ sibling: { field: BigInt(e.sibling) }, goes_left: e.goes_left })),
  };
}

// ── Rooms (WS broadcast between two players sharing a contractAddress). ────

type RoomRole = "x" | "o";
interface RoomClient {
  ws: any;
  role: RoomRole;
}
interface Room {
  clients: Map<RoomRole, RoomClient>;
  history: { type: "move"; payload: unknown }[]; // last move per turn, in order
}
const rooms = new Map<string, Room>();
function getRoom(addr: string): Room {
  let r = rooms.get(addr);
  if (!r) {
    r = { clients: new Map(), history: [] };
    rooms.set(addr, r);
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

// ── HTTP route table. ──────────────────────────────────────────────────────

type HttpHandler = (req: Request, params: Record<string, string>) => Promise<Response>;
const routes: { method: string; pattern: RegExp; keys: string[]; handler: HttpHandler }[] = [];
function route(method: string, pattern: string, handler: HttpHandler): void {
  const keys: string[] = [];
  const regex = new RegExp(
    "^" +
      pattern.replace(/:([a-zA-Z]+)/g, (_m, k) => {
        keys.push(k);
        return "([^/]+)";
      }) +
      "$",
  );
  routes.push({ method, pattern: regex, keys, handler });
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...corsHeaders() } });
const fail = (msg: string, status = 400): Response => json({ ok: false, error: msg }, status);

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}

// ── Phase 1: deploy with X's commitments only. ────────────────────────────
route("POST", "/api/deploy", async (req) => {
  const body = (await req.json()) as { idX: string; rootX: string };
  const args = {
    idX: fromHex(body.idX),
    rootX: { field: fieldBig(body.rootX) },
  };
  const initialPrivateState = createTicTacToePrivateState(new Uint8Array(32));
  return withLock("__deploy__", async () => {
    log("deploy: starting (halfOpen)…");
    const { contractAddress } = await deployTicTacToe({
      args,
      wallet,
      initialPrivateState,
      privateStateStoreName: "ttt-relay-deploy",
      midnightDbName: "tictactoe-relay-db-deploy",
    });
    log("deploy: ok ->", contractAddress);
    return json({ ok: true, contractAddress });
  });
});

// ── Phase 2: O joins by submitting their own commitments. ────────────────
route("POST", "/api/join", async (req) => {
  const body = (await req.json()) as { addr: string; idO: string; rootO: string };
  return withLock(body.addr, async () => {
    log("join: starting ->", body.addr);
    const { txId } = await joinChannelCall({
      contractAddress: body.addr,
      wallet,
      joinArgs: { idO: fromHex(body.idO), rootO: { field: fieldBig(body.rootO) } },
    });
    log("join: tx", txId);
    broadcastEvent(body.addr, "joined");
    return json({ ok: true, txId });
  });
});

// ── Read on-chain state. ──────────────────────────────────────────────────
route("GET", "/api/state/:addr", async (_req, { addr }) => {
  const { providers } = await attachTicTacToe({
    contractAddress: addr,
    wallet,
    initialPrivateState: createTicTacToePrivateState(new Uint8Array(32)),
    privateStateStoreName: `ttt-relay-read-${addr.slice(2, 12)}`,
    midnightDbName: `tictactoe-relay-db-read-${addr.slice(2, 12)}`,
  });
  const led = await readLedger(providers, addr);
  return json({
    ok: true,
    contractAddress: addr,
    status: led.status,            // 0=halfOpen, 1=inProgress, 2=settled
    statusName: ["halfOpen", "inProgress", "settled"][led.status] ?? `?(${led.status})`,
    winner: led.winner,            // 0=none, 1=x, 2=o, 3=draw
    winnerName: ["none", "x", "o", "draw"][led.winner],
    idX: toHex(led.idX),
    idO: toHex(led.idO),
    rootX: "0x" + led.rootX.field.toString(16),
    rootO: "0x" + led.rootO.field.toString(16),
    committedTurns: Number(led.committedTurns),
    turnMark: Number(led.turnMark),
    hasChallenge: led.hasChallenge,
    challengeUntil: led.challengeUntil.toString(),
    hasDeadline: led.hasDeadline,
    deadline: led.deadline.toString(),
  });
});

// ── Settle. ────────────────────────────────────────────────────────────────
route("POST", "/api/settle", async (req) => {
  const body = (await req.json()) as {
    addr: string;
    secret: string;                      // hex; needed only for startTimeout, but we accept it for symmetry
    nMoves: number;
    cells: number[];                      // length 9 (padded)
    secrets: string[];                    // length 9, hex
    paths: WirePath[];                    // length 9
    untilTime: string;                    // bigint string
  };
  const addr = body.addr;
  return withLock(addr, async () => {
    const { found } = await attachTicTacToe({
      contractAddress: addr,
      wallet,
      initialPrivateState: createTicTacToePrivateState(fromHex(body.secret)),
      privateStateStoreName: `ttt-relay-settle-${addr.slice(2, 12)}`,
      midnightDbName: `tictactoe-relay-db-settle-${addr.slice(2, 12)}`,
    });
    const cells = body.cells.map((c) => BigInt(c));
    const secrets = body.secrets.map(fromHex);
    const paths = body.paths.map(decodePath);
    const nMoves = BigInt(body.nMoves);
    const untilTime = BigInt(body.untilTime);
    log("settle ->", { addr, nMoves: Number(nMoves), untilTime: body.untilTime });
    const tx = await (found as any).callTx.settle(nMoves, cells, secrets, paths, untilTime);
    log("settle: tx", tx.public.txId);
    broadcastEvent(addr, "settled");
    return json({ ok: true, txId: tx.public.txId });
  });
});

route("POST", "/api/claim-result", async (req) => {
  const body = (await req.json()) as { addr: string };
  return withLock(body.addr, async () => {
    const { found } = await attachTicTacToe({
      contractAddress: body.addr,
      wallet,
      initialPrivateState: createTicTacToePrivateState(new Uint8Array(32)),
      privateStateStoreName: `ttt-relay-cr-${body.addr.slice(2, 12)}`,
      midnightDbName: `tictactoe-relay-db-cr-${body.addr.slice(2, 12)}`,
    });
    log("claim-result ->", body.addr);
    const tx = await (found as any).callTx.claimResult();
    log("claim-result: tx", tx.public.txId);
    broadcastEvent(body.addr, "result-claimed");
    return json({ ok: true, txId: tx.public.txId });
  });
});

route("POST", "/api/start-timeout", async (req) => {
  const body = (await req.json()) as { addr: string; secret: string; untilTime: string };
  return withLock(body.addr, async () => {
    const { found } = await attachTicTacToe({
      contractAddress: body.addr,
      wallet,
      initialPrivateState: createTicTacToePrivateState(fromHex(body.secret)),
      privateStateStoreName: `ttt-relay-st-${body.addr.slice(2, 12)}`,
      midnightDbName: `tictactoe-relay-db-st-${body.addr.slice(2, 12)}`,
    });
    log("start-timeout ->", body.addr, "until", body.untilTime);
    const tx = await (found as any).callTx.startTimeout(BigInt(body.untilTime));
    log("start-timeout: tx", tx.public.txId);
    broadcastEvent(body.addr, "timeout-armed");
    return json({ ok: true, txId: tx.public.txId });
  });
});

route("POST", "/api/claim-timeout", async (req) => {
  const body = (await req.json()) as { addr: string };
  return withLock(body.addr, async () => {
    const { found } = await attachTicTacToe({
      contractAddress: body.addr,
      wallet,
      initialPrivateState: createTicTacToePrivateState(new Uint8Array(32)),
      privateStateStoreName: `ttt-relay-ct-${body.addr.slice(2, 12)}`,
      midnightDbName: `tictactoe-relay-db-ct-${body.addr.slice(2, 12)}`,
    });
    log("claim-timeout ->", body.addr);
    const tx = await (found as any).callTx.claimTimeout();
    log("claim-timeout: tx", tx.public.txId);
    broadcastEvent(body.addr, "timeout-claimed");
    return json({ ok: true, txId: tx.public.txId });
  });
});

route("POST", "/api/prove-fraud", async (req) => {
  const body = (await req.json()) as {
    addr: string; side: "x" | "o";
    turn: number;
    cellA: number; secretA: string; pathA: WirePath;
    cellB: number; secretB: string; pathB: WirePath;
  };
  return withLock(body.addr, async () => {
    const { found } = await attachTicTacToe({
      contractAddress: body.addr,
      wallet,
      initialPrivateState: createTicTacToePrivateState(new Uint8Array(32)),
      privateStateStoreName: `ttt-relay-pf-${body.addr.slice(2, 12)}`,
      midnightDbName: `tictactoe-relay-db-pf-${body.addr.slice(2, 12)}`,
    });
    log("prove-fraud ->", body.addr, "side=", body.side);
    const fn = body.side === "x" ? "proveEquivocationByX" : "proveEquivocationByO";
    const tx = await (found as any).callTx[fn](
      BigInt(body.turn),
      BigInt(body.cellA), fromHex(body.secretA), decodePath(body.pathA),
      BigInt(body.cellB), fromHex(body.secretB), decodePath(body.pathB),
    );
    log("prove-fraud: tx", tx.public.txId);
    broadcastEvent(body.addr, "fraud-proved");
    return json({ ok: true, txId: tx.public.txId });
  });
});

// ── WebSocket relay. ───────────────────────────────────────────────────────

function broadcastEvent(addr: string, kind: string) {
  const room = rooms.get(addr);
  if (!room) return;
  broadcast(room, null, { type: "event", addr, kind });
}

// ── Server. ────────────────────────────────────────────────────────────────

const server = Bun.serve({
  port: PORT,
  websocket: {
    open(ws) {
      (ws as any).data = { addr: null, role: null };
    },
    message(ws, message) {
      let msg: any;
      try {
        msg = JSON.parse(String(message));
      } catch {
        return;
      }
      switch (msg.type) {
        case "join": {
          if (typeof msg.addr !== "string" || (msg.role !== "x" && msg.role !== "o")) return;
          const room = getRoom(msg.addr);
          if (room.clients.has(msg.role)) {
            // Replace any existing socket (handles reload).
            try { room.clients.get(msg.role)!.ws.close(); } catch {}
          }
          room.clients.set(msg.role, { ws, role: msg.role });
          (ws as any).data = { addr: msg.addr, role: msg.role };
          log("ws join", msg.addr.slice(0, 10), msg.role, `(room size=${room.clients.size})`);
          // Replay any moves to the late joiner.
          for (const m of room.history) {
            try { ws.send(JSON.stringify(m)); } catch {}
          }
          // Tell the other peer somebody joined.
          broadcast(room, msg.role, { type: "joined", addr: msg.addr, role: msg.role });
          break;
        }
        case "move": {
          const { addr, role } = (ws as any).data;
          if (!addr || !role) return;
          const room = getRoom(addr);
          room.history.push({ type: "move", payload: msg.payload });
          log("ws move", addr.slice(0, 10), "turn=", msg.payload?.turn, "from=", role);
          broadcast(room, role, { type: "move", addr, payload: msg.payload });
          break;
        }
        case "event": {
          const { addr } = (ws as any).data;
          if (!addr) return;
          const room = getRoom(addr);
          broadcast(room, null, { type: "event", addr, kind: msg.kind });
          break;
        }
        case "leave": {
          // Handled on close.
          break;
        }
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
  async fetch(req: Request) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });
    // WS upgrade.
    if (url.pathname === "/relay") {
      const ok = (server as any).upgrade(req);
      return ok ? undefined : new Response("ws upgrade failed", { status: 500 });
    }
    // HTTP routes.
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.pattern);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1] ?? "")));
      try {
        return await r.handler(req, params);
      } catch (e) {
        log("HTTP error", url.pathname, e instanceof Error ? e.message : e);
        return fail(e instanceof Error ? e.message : String(e), 500);
      }
    }
    if (url.pathname === "/" || url.pathname === "/api/health") return json({ ok: true });
    return fail("not found", 404);
  },
});

log(`relay: http+ws on http://localhost:${PORT}`);
