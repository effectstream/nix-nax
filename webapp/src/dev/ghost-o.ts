// Dev-only "ghost O" — an in-page autonomous opponent for smoke-testing the
// full protocol from a single browser. It owns a real O PlayerSession (its
// own three trees), speaks the relay WS protocol, and plays a simple legal
// strategy: place at the first legal cell (small first), remove the first
// removable piece, pass when forced.
//
// Not imported by the app — load it from the console / preview eval:
//   const g = await import("/src/dev/ghost-o.ts");
//   await g.startGhostO(addr);            // uses the blob saved by makeGhostO
//
// `makeGhostO()` generates O's keys and persists them to localStorage so the
// ghost survives reloads (key: ghost-o:<addr>).

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
} from "../game/player-session.ts";
import {
  KIND_PLACE,
  KIND_REMOVE,
  KIND_PASS,
  SETTLE_CHUNK,
  canPlace,
  canRemove,
  type Action,
} from "../../../src/sdk/game/rules.ts";

const log = (...a: unknown[]) => console.log("[ghost O]", ...a);

// Generate O's keys for a gameId, return the join payload, and stash a
// restorable session blob under ghost-o:<gameId>.
export function makeGhostO(gameIdHex: string): { idO: string; rootO: string; rootIdxO: string; rootRndO: string } {
  const gidBytes = Uint8Array.from((gameIdHex.match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)));
  const keys = generatePlayerKeys("o", gidBytes);
  const session = new PlayerSession("o", gameIdHex, keys, null);
  localStorage.setItem(`ghost-o:${gameIdHex}`, JSON.stringify(session.serialise()));
  const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
  return {
    idO: hex(keys.id),
    rootO: "0x" + keys.tokenTree.root.field.toString(16),
    rootIdxO: "0x" + keys.indexTree.root.field.toString(16),
    rootRndO: "0x" + keys.randomTree.root.field.toString(16),
  };
}

export interface GhostHandle {
  session: PlayerSession;
  ws: WebSocket;
  stop(): void;
  // Settle turns [0, session.committedTurns) honestly via the relay.
  settleHonest(windowSec?: number): Promise<void>;
  // Craft a LYING settle: honest prefix + one fabricated O move with a
  // flipped claimed parity (place on an even turn). For the fraud demo.
  settleWithParityLie(): Promise<{ turn: number }>;
}

export async function startGhostO(addr: string): Promise<GhostHandle> {
  // `addr` is the gameId (hex) — the room key and channel id.
  const raw = localStorage.getItem(`ghost-o:${addr}`);
  if (!raw) throw new Error("no ghost-o blob for this address — call makeGhostO first");
  const session = PlayerSession.restore(JSON.parse(raw) as SerializedSession);

  // Fetch X's commitments from chain.
  const st = await fetch(`/api/state/${addr}`).then((r) => r.json());
  const fromHex = (s: string) => new Uint8Array(((s.startsWith("0x") ? s.slice(2) : s).match(/.{1,2}/g) ?? []).map((b: string) => parseInt(b, 16)));
  session.setOpponent({
    id: fromHex(st.idX),
    rootToken: BigInt(st.rootX),
    rootIdx: BigInt(st.rootIdxX),
    rootRnd: BigInt(st.rootRndX),
  });

  const persist = () => localStorage.setItem(`ghost-o:${addr}`, JSON.stringify(session.serialise()));

  const ws = new WebSocket(`ws://${location.host}/relay`);
  const send = (m: object) => ws.send(JSON.stringify(m));

  const chooseAction = (parity: 0 | 1): Action | null => {
    const board = session.boardState;
    const reserves = session.reserveState;
    if (parity === 1) {
      for (let size = 0; size < 4; size++) {
        for (let cell = 0; cell < 16; cell++) {
          if (canPlace(board, reserves, 2, size, cell)) return { kind: KIND_PLACE, cell, size };
        }
      }
      return null; // stalled
    }
    for (let cell = 0; cell < 16; cell++) {
      if (canRemove(board, 2, cell)) return { kind: KIND_REMOVE, cell, size: 0 };
    }
    return { kind: KIND_PASS, cell: 0, size: 0 };
  };

  const actIfReady = () => {
    const ph = session.turnPhase;
    if (ph.phase === "myIntent") {
      const it = session.myIntent();
      send({ type: "intent", addr, payload: encodeIntent(it) });
      log(`intent turn=${it.turn} slot=${it.slot} bits=${it.bits.join("")}`);
      persist();
      return;
    }
    if (ph.phase !== "act") return;
    const parity = ph.parity ?? 1; // turn 0 is X's, so parity null never hits the ghost
    const action = chooseAction(parity);
    if (!action) { log("stalled — no legal placement"); return; }
    const move = session.myMove(action);
    send({ type: "move", addr, payload: encodeMove(move) });
    log(`move turn=${move.turn} kind=${move.kind} cell=${move.cell} size=${move.size}`);
    persist();
  };

  ws.addEventListener("open", () => {
    send({ type: "join", addr, role: "o" });
    log("joined room", addr.slice(0, 12));
    setTimeout(actIfReady, 300); // in case it's already our turn (replay)
  });
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.type === "intent") {
      const it = decodeIntent(msg.payload);
      const r = session.receiveIntent(it);
      log(`recv intent turn=${it.turn} slot=${it.slot} ->`, r.ok ? "ok" : r.reason);
      if (!r.ok) return;
      const reveal = session.respondWithRandom();
      send({ type: "random", addr, payload: encodeRandomReveal(reveal) });
      log(`random turn=${reveal.turn} bits=${reveal.bits.join("")}`);
      persist();
    } else if (msg.type === "random") {
      const rv = decodeRandomReveal(msg.payload);
      const r = session.receiveRandomReveal(rv);
      log(`recv random turn=${rv.turn} ->`, r.ok ? `parity=${session.parityForTurn(rv.turn)}` : r.reason);
      if (r.ok) { persist(); actIfReady(); }
    } else if (msg.type === "move") {
      const m = decodeMove(msg.payload);
      const r = session.receiveMove(m);
      log(`recv move turn=${m.turn} ->`, r.ok ? r.status : r.reason);
      if (r.ok) { persist(); actIfReady(); }
    }
  });

  const hexStr = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");

  const handle: GhostHandle = {
    session,
    ws,
    stop() { try { ws.close(); } catch { /* noop */ } },

    async settleHonest(windowSec = 12) {
      const st2 = await fetch(`/api/state/${addr}`).then((r) => r.json());
      const until = Math.floor(Date.now() / 1000) + windowSec;
      const chunks = session.settleChunkPayloads(st2.committedTurns ?? 0, until);
      for (const c of chunks) {
        const res = await fetch("/api/settle", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ gameId: addr, secret: hexStr(session.keys.secret), ...c }),
        }).then((r) => r.json());
        if (!res.ok) throw new Error(res.error);
        log("settled chunk tx", res.txId);
      }
    },

    // Fabricate: settle an honest PREFIX of the played history, then append
    // ONE lying move at the earliest O turn whose real parity was 0 — O
    // claims parity 1 and substitutes a placement. Rules are validated
    // against the CLAIMED parity and the token comes from O's own T-tree,
    // so the contract accepts it; the honest side holds both committed bits
    // for that turn and proves the lie via proveWrongParity.
    async settleWithParityLie() {
      // Earliest O turn (odd) with real parity 0 in the played history.
      let lieTurn = -1;
      for (let t = 1; t < session.committedTurns; t++) {
        if (t % 2 === 1 && session.parityForTurn(t) === 0) { lieTurn = t; break; }
      }
      if (lieTurn < 0) throw new Error("no even-parity O turn in history to lie about");

      // Replay the prefix to find a legal lying placement at lieTurn.
      const rules = await import("../../../src/sdk/game/rules.ts");
      let board = rules.emptyBoard();
      let reserves = rules.fullReserves();
      const prefix = session.moves.slice(0, lieTurn);
      for (const m of prefix) {
        ({ board, reserves } = rules.applyAction(
          board, reserves, rules.moverForTurn(m.turn),
          { kind: m.kind, cell: m.cell, size: m.size } as Action,
        ));
      }
      let lie: Action | null = null;
      for (let size = 0; size < 4 && !lie; size++) {
        for (let cell = 0; cell < 16 && !lie; cell++) {
          if (canPlace(board, reserves, 2, size, cell)) lie = { kind: KIND_PLACE, cell, size };
        }
      }
      if (!lie) throw new Error("no legal placement to lie with");

      const { secretFor } = await import("../../../src/sdk/crypto/token-tree.ts");
      const tree = session.keys.tokenTree;
      const encP = (p: { leaf: Uint8Array; path: { sibling: { field: bigint }; goes_left: boolean }[] }) => ({
        leaf: hexStr(p.leaf),
        path: p.path.map((e) => ({ sibling: "0x" + e.sibling.field.toString(16), goes_left: e.goes_left })),
      });

      type Entry = { parity: number; kind: number; cell: number; size: number; secret: string; path: ReturnType<typeof encP> };
      const entries: Entry[] = prefix.map((m) => ({
        parity: m.turn === 0 ? 1 : (session.parityForTurn(m.turn) ?? 0),
        kind: m.kind, cell: m.cell, size: m.size,
        secret: hexStr(m.token.secret),
        path: encP(m.token.path),
      }));
      entries.push({
        parity: 1, // THE LIE — the committed bits XOR to 0
        kind: lie.kind, cell: lie.cell, size: lie.size,
        secret: hexStr(secretFor(tree, lieTurn, lie.kind, lie.cell, lie.size)),
        path: encP(tree.pathFor(lieTurn, lie.kind, lie.cell, lie.size)),
      });

      const until = Math.floor(Date.now() / 1000) + 60;
      const zeroPath = { leaf: hexStr(new Uint8Array(32)), path: Array.from({ length: 14 }, () => ({ sibling: "0x0", goes_left: false })) };
      for (let base = 0; base < entries.length; base += SETTLE_CHUNK) {
        const slice = entries.slice(base, base + SETTLE_CHUNK);
        const body = {
          gameId: addr,
          secret: hexStr(session.keys.secret),
          nMoves: slice.length,
          parities: Array.from({ length: SETTLE_CHUNK }, (_, i) => slice[i]?.parity ?? 0),
          kinds: Array.from({ length: SETTLE_CHUNK }, (_, i) => slice[i]?.kind ?? 0),
          cells: Array.from({ length: SETTLE_CHUNK }, (_, i) => slice[i]?.cell ?? 0),
          sizes: Array.from({ length: SETTLE_CHUNK }, (_, i) => slice[i]?.size ?? 0),
          secrets: Array.from({ length: SETTLE_CHUNK }, (_, i) => slice[i]?.secret ?? hexStr(new Uint8Array(32))),
          paths: Array.from({ length: SETTLE_CHUNK }, (_, i) => slice[i]?.path ?? zeroPath),
          untilTime: String(until),
        };
        const res = await fetch("/api/settle", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }).then((r) => r.json());
        if (!res.ok) throw new Error(res.error);
        log("lying settle chunk tx", res.txId);
      }
      log(`parity lie settled at turn ${lieTurn} — the honest side can now prove it`);
      return { turn: lieTurn };
    },
  };

  (globalThis as any).__GHOST_O__ = handle;
  return handle;
}
