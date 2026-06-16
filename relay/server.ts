// Arena relay + thin chain backend.
//
//   HTTP (REST/JSON):  on-chain actions (create/join game, settle, disputes)
//   WS  (per-room):    off-chain message exchange (intent / random / move)
//
// The relay deploys the multi-game GobbletArena contract ONCE at boot (or
// reuses a persisted deployment) and caches the call handle — every game is
// a fast circuit call afterwards. Rooms and all endpoints are keyed by the
// 32-byte gameId (hex); the contract address never leaves the relay.

import { buildAndFundWallet, type WalletBundle } from "../src/sdk/wallet.ts";
import { NETWORK } from "../src/sdk/env.ts";
import {
  ensureArenaDeployed,
  attachWithSecret,
  readLedger,
  buildDustlessCallTxHex,
  type ArenaHandle,
} from "../src/sdk/deploy.ts";

const PORT = Number(process.env.RELAY_PORT ?? 4310);
const log = (...args: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...args);

// ── Boot: wallet + one-time arena deployment. ──────────────────────────────

log("relay: booting; waiting for stack and wallet…");
const wallet: WalletBundle = await buildAndFundWallet(
  NETWORK,
  process.env.MIDNIGHT_WALLET_SEED ??
    "0000000000000000000000000000000000000000000000000000000000000001",
);
log("relay: wallet ready");

const arena: ArenaHandle = await ensureArenaDeployed({ wallet });
log(`relay: arena ${arena.reused ? "reused" : "deployed"} at ${arena.contractAddress}`);

// ── Single-wallet serialization: one nonce/UTXO stream → one queue. ────────
const queues = new Map<string, Promise<unknown>>();
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const guarded = next.catch(() => undefined);
  guarded.then(() => {
    if (queues.get(key) === guarded) queues.delete(key);
  });
  queues.set(key, guarded);
  return next;
}

process.on("unhandledRejection", (reason) => {
  console.error("[relay] unhandledRejection:", reason instanceof Error ? reason.message : reason);
});
process.on("uncaughtException", (err) => {
  console.error("[relay] uncaughtException:", err.message);
});

// ── Codecs. ─────────────────────────────────────────────────────────────────

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

const gid = (s: string): Uint8Array => {
  const b = fromHex(s);
  if (b.length !== 32) throw new Error("gameId must be 32 bytes of hex");
  return b;
};

const bits4 = (xs: number[]): [bigint, bigint, bigint, bigint] => {
  if (!Array.isArray(xs) || xs.length !== 4) throw new Error("bits must be a 4-element array");
  return [BigInt(xs[0]), BigInt(xs[1]), BigInt(xs[2]), BigInt(xs[3])];
};

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
function getRoom(gameId: string): Room {
  let r = rooms.get(gameId);
  if (!r) {
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
function broadcastEvent(gameId: string, kind: string) {
  const room = rooms.get(gameId);
  if (!room) return;
  broadcast(room, null, { type: "event", addr: gameId, kind });
}

// ── HTTP route table. ───────────────────────────────────────────────────────

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

// ── Game lifecycle. ─────────────────────────────────────────────────────────

route("POST", "/api/create-game", async (req) => {
  const body = (await req.json()) as {
    gameId: string;
    idX: string;
    rootX: string;
    rootIdxX: string;
    rootRndX: string;
    gasPayer?: "wallet" | "relay";
  };
  const args = [
    gid(body.gameId),
    fromHex(body.idX),
    { field: fieldBig(body.rootX) },
    { field: fieldBig(body.rootIdxX) },
    { field: fieldBig(body.rootRndX) },
  ];
  // gasPayer "wallet": return a dust-less proven tx for the player's browser
  // wallet to balance + submit (they pay gas). No nonce here → no wallet lock.
  if (body.gasPayer === "wallet") {
    log("create-game (wallet-pays) ->", body.gameId.slice(0, 12));
    const txHex = await buildDustlessCallTxHex(arena, "createGame", args);
    return json({ ok: true, txHex, gameId: body.gameId });
  }
  return withLock("__wallet__", async () => {
    log("create-game ->", body.gameId.slice(0, 12));
    const tx = await (arena.found as any).callTx.createGame(...args);
    log("create-game: tx", tx.public.txId);
    return json({ ok: true, txId: tx.public.txId, gameId: body.gameId });
  });
});

route("POST", "/api/join", async (req) => {
  const body = (await req.json()) as {
    gameId: string;
    idO: string;
    rootO: string;
    rootIdxO: string;
    rootRndO: string;
    gasPayer?: "wallet" | "relay";
  };
  const args = [
    gid(body.gameId),
    fromHex(body.idO),
    { field: fieldBig(body.rootO) },
    { field: fieldBig(body.rootIdxO) },
    { field: fieldBig(body.rootRndO) },
  ];
  if (body.gasPayer === "wallet") {
    log("join (wallet-pays) ->", body.gameId.slice(0, 12));
    const txHex = await buildDustlessCallTxHex(arena, "joinGame", args);
    return json({ ok: true, txHex });
  }
  return withLock("__wallet__", async () => {
    log("join ->", body.gameId.slice(0, 12));
    const tx = await (arena.found as any).callTx.joinGame(...args);
    log("join: tx", tx.public.txId);
    broadcastEvent(body.gameId, "joined");
    return json({ ok: true, txId: tx.public.txId });
  });
});

// ── Read per-game on-chain state. ───────────────────────────────────────────

route("GET", "/api/state/:gameId", async (_req, { gameId }) => {
  const g = gid(gameId);
  const led = await readLedger(arena.providers, arena.contractAddress);
  if (!led.gameKeys.member(g)) return fail("no such game", 404);
  const keys = led.gameKeys.lookup(g);
  const dyn = led.gameState.lookup(g);

  const innerBoard = led.boards.lookup(g);
  const board: number[] = [];
  for (let k = 0; k < 64; k++) {  // 16 cells × 4 layers
    const key = BigInt(k);
    board.push(innerBoard.member(key) ? Number(innerBoard.lookup(key)) : 0);
  }
  const innerTops = led.tops.lookup(g);
  const topsArr: number[] = [];
  for (let c = 0; c < 16; c++) {
    const key = BigInt(c);
    topsArr.push(innerTops.member(key) ? Number(innerTops.lookup(key)) : 0);
  }
  const innerRes = led.reserves.lookup(g);
  const reservesObj: Record<string, number> = {};
  for (const mark of [1, 2]) {
    for (let s = 0; s < 4; s++) {
      const key = BigInt(mark * 4 + s);
      reservesObj[`${mark === 1 ? "x" : "o"}${s}`] = innerRes.member(key) ? Number(innerRes.lookup(key)) : 0;
    }
  }
  const innerLog = led.actionLogs.lookup(g);
  const actionLog: { turn: number; packed: number }[] = [];
  for (const [turn, packed] of innerLog) {
    actionLog.push({ turn: Number(turn), packed: Number(packed) });
  }
  actionLog.sort((a, b) => a.turn - b.turn);

  return json({
    ok: true,
    gameId,
    status: dyn.status,
    statusName: ["halfOpen", "inProgress", "settled"][dyn.status] ?? `?(${dyn.status})`,
    winner: dyn.winner,
    winnerName: ["none", "x", "o", "draw"][dyn.winner],
    idX: toHex(keys.idX),
    idO: toHex(keys.idO),
    rootX: "0x" + keys.rootX.field.toString(16),
    rootO: "0x" + keys.rootO.field.toString(16),
    rootIdxX: "0x" + keys.rootIdxX.field.toString(16),
    rootIdxO: "0x" + keys.rootIdxO.field.toString(16),
    rootRndX: "0x" + keys.rootRndX.field.toString(16),
    rootRndO: "0x" + keys.rootRndO.field.toString(16),
    committedTurns: Number(dyn.committedTurns),
    turnMark: Number(dyn.turnMark),
    hasChallenge: dyn.hasChallenge,
    challengeUntil: dyn.challengeUntil.toString(),
    hasDeadline: dyn.hasDeadline,
    deadline: dyn.deadline.toString(),
    board,
    tops: topsArr,
    reserves: reservesObj,
    actionLog,
  });
});

// ── Settle (one chunk of up to 8 moves). ────────────────────────────────────

route("POST", "/api/settle", async (req) => {
  const body = (await req.json()) as {
    gameId: string;
    secret: string;
    nMoves: number;
    parities: number[];
    kinds: number[];
    cells: number[];
    sizes: number[];
    secrets: string[];
    paths: WirePath[];
    untilTime: string;
  };
  return withLock("__wallet__", async () => {
    const toBig = (xs: number[]) => xs.map((v) => BigInt(v));
    log("settle ->", body.gameId.slice(0, 12), "nMoves:", body.nMoves);
    const tx = await (arena.found as any).callTx.settle(
      gid(body.gameId),
      BigInt(body.nMoves),
      toBig(body.parities),
      toBig(body.kinds),
      toBig(body.cells),
      toBig(body.sizes),
      body.secrets.map(fromHex),
      body.paths.map(decodePath),
      BigInt(body.untilTime),
    );
    log("settle: tx", tx.public.txId);
    broadcastEvent(body.gameId, "settled");
    return json({ ok: true, txId: tx.public.txId });
  });
});

route("POST", "/api/claim-result", async (req) => {
  const body = (await req.json()) as { gameId: string };
  return withLock("__wallet__", async () => {
    log("claim-result ->", body.gameId.slice(0, 12));
    const tx = await (arena.found as any).callTx.claimResult(gid(body.gameId));
    log("claim-result: tx", tx.public.txId);
    broadcastEvent(body.gameId, "result-claimed");
    return json({ ok: true, txId: tx.public.txId });
  });
});

route("POST", "/api/start-timeout", async (req) => {
  const body = (await req.json()) as { gameId: string; secret: string; untilTime: string };
  return withLock("__wallet__", async () => {
    // startTimeout consumes the localSecret witness — attach with the
    // caller's secret in private state for this one call.
    const { found } = await attachWithSecret({
      contractAddress: arena.contractAddress,
      wallet,
      secret: fromHex(body.secret),
      storeSuffix: `st-${body.gameId.slice(0, 10)}`,
    });
    log("start-timeout ->", body.gameId.slice(0, 12), "until", body.untilTime);
    const tx = await (found as any).callTx.startTimeout(gid(body.gameId), BigInt(body.untilTime));
    log("start-timeout: tx", tx.public.txId);
    broadcastEvent(body.gameId, "timeout-armed");
    return json({ ok: true, txId: tx.public.txId });
  });
});

route("POST", "/api/claim-timeout", async (req) => {
  const body = (await req.json()) as { gameId: string };
  return withLock("__wallet__", async () => {
    log("claim-timeout ->", body.gameId.slice(0, 12));
    const tx = await (arena.found as any).callTx.claimTimeout(gid(body.gameId));
    log("claim-timeout: tx", tx.public.txId);
    broadcastEvent(body.gameId, "timeout-claimed");
    return json({ ok: true, txId: tx.public.txId });
  });
});

// ── Fraud proofs. ───────────────────────────────────────────────────────────

route("POST", "/api/prove-fraud", async (req) => {
  const body = (await req.json()) as {
    gameId: string; side: "x" | "o";
    turn: number;
    kindA: number; cellA: number; sizeA: number; secretA: string; pathA: WirePath;
    kindB: number; cellB: number; sizeB: number; secretB: string; pathB: WirePath;
  };
  return withLock("__wallet__", async () => {
    log("prove-fraud ->", body.gameId.slice(0, 12), "side=", body.side, "turn=", body.turn);
    const fn = body.side === "x" ? "proveEquivocationByX" : "proveEquivocationByO";
    const tx = await (arena.found as any).callTx[fn](
      gid(body.gameId),
      BigInt(body.turn),
      BigInt(body.kindA), BigInt(body.cellA), BigInt(body.sizeA), fromHex(body.secretA), decodePath(body.pathA),
      BigInt(body.kindB), BigInt(body.cellB), BigInt(body.sizeB), fromHex(body.secretB), decodePath(body.pathB),
    );
    log("prove-fraud: tx", tx.public.txId);
    broadcastEvent(body.gameId, "fraud-proved");
    return json({ ok: true, txId: tx.public.txId });
  });
});

route("POST", "/api/prove-index-fraud", async (req) => {
  const body = (await req.json()) as {
    gameId: string; side: "x" | "o";
    turn: number;
    slotA: number; bitsA: number[]; secretA: string; pathA: WirePath;
    slotB: number; bitsB: number[]; secretB: string; pathB: WirePath;
  };
  return withLock("__wallet__", async () => {
    log("prove-index-fraud ->", body.gameId.slice(0, 12), "side=", body.side);
    const fn = body.side === "x" ? "proveIndexEquivocationByX" : "proveIndexEquivocationByO";
    const tx = await (arena.found as any).callTx[fn](
      gid(body.gameId),
      BigInt(body.turn),
      BigInt(body.slotA), ...bits4(body.bitsA), fromHex(body.secretA), decodePath(body.pathA),
      BigInt(body.slotB), ...bits4(body.bitsB), fromHex(body.secretB), decodePath(body.pathB),
    );
    log("prove-index-fraud: tx", tx.public.txId);
    broadcastEvent(body.gameId, "fraud-proved");
    return json({ ok: true, txId: tx.public.txId });
  });
});

route("POST", "/api/prove-random-fraud", async (req) => {
  const body = (await req.json()) as {
    gameId: string; side: "x" | "o";
    turn: number; slot: number;
    bitsA: number[]; randomA: string; pathA: WirePath;
    bitsB: number[]; randomB: string; pathB: WirePath;
  };
  return withLock("__wallet__", async () => {
    log("prove-random-fraud ->", body.gameId.slice(0, 12), "side=", body.side);
    const fn = body.side === "x" ? "proveRandomEquivocationByX" : "proveRandomEquivocationByO";
    const tx = await (arena.found as any).callTx[fn](
      gid(body.gameId),
      BigInt(body.turn),
      BigInt(body.slot),
      ...bits4(body.bitsA), fromHex(body.randomA), decodePath(body.pathA),
      ...bits4(body.bitsB), fromHex(body.randomB), decodePath(body.pathB),
    );
    log("prove-random-fraud: tx", tx.public.txId);
    broadcastEvent(body.gameId, "fraud-proved");
    return json({ ok: true, txId: tx.public.txId });
  });
});

route("POST", "/api/prove-wrong-parity", async (req) => {
  const body = (await req.json()) as {
    gameId: string;
    turn: number; slot: number;
    bitsI: number[]; secretI: string; pathI: WirePath;
    bitsR: number[]; randomR: string; pathR: WirePath;
  };
  return withLock("__wallet__", async () => {
    log("prove-wrong-parity ->", body.gameId.slice(0, 12), "turn=", body.turn);
    const tx = await (arena.found as any).callTx.proveWrongParity(
      gid(body.gameId),
      BigInt(body.turn),
      BigInt(body.slot),
      ...bits4(body.bitsI), fromHex(body.secretI), decodePath(body.pathI),
      ...bits4(body.bitsR), fromHex(body.randomR), decodePath(body.pathR),
    );
    log("prove-wrong-parity: tx", tx.public.txId);
    broadcastEvent(body.gameId, "fraud-proved");
    return json({ ok: true, txId: tx.public.txId });
  });
});

// ── Server (HTTP + WS). ─────────────────────────────────────────────────────

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
          room.history.push({ type: msg.type, payload: msg.payload });
          log(`ws ${msg.type}`, addr.slice(0, 10), "turn=", msg.payload?.turn, "from=", role);
          broadcast(room, role, { type: msg.type, addr, payload: msg.payload });
          break;
        }
        case "event": {
          const { addr } = (ws as any).data;
          if (!addr) return;
          const room = getRoom(addr);
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
  async fetch(req: Request) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });
    if (url.pathname === "/relay") {
      const ok = (server as any).upgrade(req);
      return ok ? undefined : new Response("ws upgrade failed", { status: 500 });
    }
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
    if (url.pathname === "/" || url.pathname === "/api/health") {
      return json({ ok: true, arena: arena.contractAddress });
    }
    return fail("not found", 404);
  },
});

log(`relay: http+ws on http://localhost:${PORT}`);
