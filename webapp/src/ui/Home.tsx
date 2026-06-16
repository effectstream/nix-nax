import { useEffect, useState } from "react";
import { api, type ContractState } from "../chain/arena.ts";
import { generatePlayerKeys, PlayerSession } from "../game/player-session.ts";
import { dropSession, listSessions, loadSession, saveSession, markVsAi, clearVsAi, type IndexEntry } from "../game/storage.ts";
import { logEvent } from "../game/log-store.ts";
import { colorOfRole } from "../game/labels.ts";
import { submitCreateGame, submitJoin } from "../wallet/submit.ts";
import Board3D from "./Board3D.tsx";
import { emptyBoard, fullReserves } from "../../../src/sdk/game/rules.ts";
import { randomGameId } from "../../../src/sdk/crypto/persistent-hash.ts";
import { useWallet, isConnected, openWalletModal } from "../wallet/useWallet.ts";
import { pingRelay } from "../api/ws.ts";

export interface HomeProps {
  onOpen: (session: PlayerSession) => void;
}

type Role = "x" | "o";
const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");

// Let the browser paint the loading overlay before the synchronous Merkle-tree
// build freezes the main thread. A setTimeout macrotask (not requestAnimationFrame)
// so it still resolves in a backgrounded/headless tab, where rAF is paused.
const yieldPaint = () => new Promise<void>((r) => setTimeout(r, 40));

const timeAgo = (ms?: number) => {
  if (!ms) return "—";
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

const stateSummary = (s: ContractState): string =>
  s.status === 0 ? "waiting for opponent"
  : s.status === 1 ? `in progress · ${s.committedTurns} turn(s)`
  : `settled · winner ${s.winnerName === "draw" ? "draw" : colorOfRole(s.winnerName as "x" | "o")}`;

type View = "menu" | "join" | "reconnect";

// Underlined glossary term with a hover tooltip.
function Term({ word, tip }: { word: string; tip: string }) {
  return <span className="term">{word}<span className="tip">{tip}</span></span>;
}

export default function Home({ onOpen }: HomeProps) {
  const [view, setView] = useState<View>("menu");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [joinId, setJoinId] = useState("");
  const [reconId, setReconId] = useState("");
  const [reconRole, setReconRole] = useState<Role>("o");
  const [saved, setSaved] = useState<IndexEntry[]>([]);
  const [states, setStates] = useState<Record<string, string>>({});
  const wallet = useWallet();
  const connected = isConnected(wallet);
  const [relayUp, setRelayUp] = useState<boolean | null>(null); // null = still checking

  // Lobby actions require a connected wallet (the local Session Wallet + Auto
  // Faucet, or a real extension). If none, open the Wallet panel to prompt one.
  const gated = (action: () => void) => () => {
    if (!connected) {
      setError("Connect a wallet to play — choose one in the Wallet panel.");
      openWalletModal();
      return;
    }
    action();
  };

  useEffect(() => {
    const list = listSessions();
    setSaved(list);
    api.health()
      .then((h) => logEvent(`chain reachable${h.arena ? ` — arena ${h.arena.slice(0, 12)}…` : ""}`))
      .catch((e) => logEvent(`! chain unreachable: ${(e as Error).message}`));
    // Ping the multiplayer relay — when it's offline (e.g. a static deploy with no
    // relay server) the multiplayer modes are disabled; Practice vs AI still works.
    pingRelay().then((up) => {
      setRelayUp(up);
      logEvent(up ? "relay: online — multiplayer available" : "relay: offline — Practice vs AI only");
    });
    // Fetch each saved game's on-chain state for the Reconnect list.
    const seen = new Set<string>();
    for (const e of list) {
      if (seen.has(e.addr)) continue;
      seen.add(e.addr);
      api.state(e.addr)
        .then((s) => setStates((m) => ({ ...m, [e.addr]: stateSummary(s) })))
        .catch(() => setStates((m) => ({ ...m, [e.addr]: "unknown (relay/chain)" })));
    }
  }, []);

  // New game: random gameId + keys, then ONE fast createGame call. With
  // `vsAi`, the game is flagged so GameView spins up a local AI as BLUE/O.
  const newGame = async (vsAi = false) => {
    setError(null);
    setBusy(vsAi ? "Starting AI match — building Merkle trees…" : "Creating game — building Merkle trees…");
    await yieldPaint();
    try {
      const gameId = randomGameId();
      const gidHex = hex(gameId);
      logEvent(`create-game: generating keys for ${gidHex.slice(0, 12)}…`);
      const x = generatePlayerKeys("x", gameId);
      setBusy("Creating game — submitting transaction…");
      await yieldPaint();
      logEvent("create-game: submitting tx…");
      const res = await submitCreateGame({
        gameId: gidHex,
        idX: hex(x.id),
        rootX: "0x" + x.tokenTree.root.field.toString(16),
        rootIdxX: "0x" + x.indexTree.root.field.toString(16),
        rootRndX: "0x" + x.randomTree.root.field.toString(16),
      });
      logEvent(`create-game: submitted via ${res.via}${res.txId ? ` (tx ${res.txId.slice(0, 16)}…)` : ""}`);
      const xSession = new PlayerSession("x", gidHex, x, null);
      saveSession(xSession.serialise());
      if (vsAi) markVsAi(gidHex);
      logEvent(vsAi
        ? `vs-AI game ${gidHex.slice(0, 12)}… created — the AI (BLUE) will join shortly`
        : `game ${gidHex.slice(0, 12)}… created — share the game id with the BLUE player`);
      onOpen(xSession);
    } catch (e) {
      setError((e as Error).message);
      logEvent(`! create-game failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  // Join: O generates their own keys for the pasted gameId.
  const joinGame = async () => {
    setError(null);
    const gidHex = joinId.trim().toLowerCase().replace(/^0x/, "");
    if (!/^[0-9a-f]{64}$/.test(gidHex)) { setError("game id must be 64 hex chars"); return; }
    setBusy("Joining — building Merkle trees…");
    await yieldPaint();
    try {
      const gameId = Uint8Array.from(gidHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
      logEvent(`join: generating keys for ${gidHex.slice(0, 12)}…`);
      const o = generatePlayerKeys("o", gameId);
      const myIdHex = hex(o.id);
      // Persist O's keys BEFORE the join tx — recoverable via Reconnect if the
      // request hangs or the tab reloads (dropped again on a front-run abort).
      saveSession(new PlayerSession("o", gidHex, o, null).serialise());
      setBusy("Joining — submitting transaction…");
      await yieldPaint();
      try {
        logEvent("join: submitting tx…");
        const r = await submitJoin({
          gameId: gidHex,
          idO: myIdHex,
          rootO: "0x" + o.tokenTree.root.field.toString(16),
          rootIdxO: "0x" + o.indexTree.root.field.toString(16),
          rootRndO: "0x" + o.randomTree.root.field.toString(16),
        });
        logEvent(`join: submitted via ${r.via}${r.txId ? ` (tx ${r.txId.slice(0, 16)}…)` : ""}`);
      } catch (e) {
        // Already joined? Idempotent if the chain holds OUR credentials.
        const state = await api.state(gidHex);
        if (state.status === 0) throw new Error(`join failed: ${(e as Error).message}`);
        if (state.idO.toLowerCase() === myIdHex.toLowerCase()) {
          logEvent("join: already on-chain with our credentials (idempotent)");
        } else {
          dropSession(gidHex, "o");
          throw new Error("⚠️ game already joined with DIFFERENT credentials — possible front-run. Walk away.");
        }
      }
      onOpen(new PlayerSession("o", gidHex, o, null));
    } catch (e) {
      setError((e as Error).message);
      logEvent(`! join failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const removeSession = (addr: string, role: Role) => {
    dropSession(addr, role);
    clearVsAi(addr);
    setSaved(listSessions());
    logEvent(`removed ${colorOfRole(role)} session for ${addr.slice(0, 12)}… from this browser`);
  };

  const reconnect = (gameId: string, role: Role) => {
    setError(null);
    const stored = loadSession(gameId.trim().toLowerCase().replace(/^0x/, ""), role);
    if (!stored) { setError(`No saved ${colorOfRole(role)} session for that game id in this browser.`); return; }
    logEvent(`reconnected ${colorOfRole(role)} session for ${gameId.slice(0, 12)}…`);
    onOpen(PlayerSession.restore(stored));
  };

  return (
    <div className="stage-root">
      <div className="board-stage">
        <Board3D board={emptyBoard()} reserves={fullReserves()} myMark={1} mode="view" active={false} spectator />
      </div>

      <div className="landing">
        <div className="landing-card glass">
          <p className="brand"><span className="x">STACKED</span> 4×4 · MIDNIGHT</p>
          <h1 className="title">Nix-Nax</h1>
          <p className="muted">
            A{" "}
            <Term word="trustless" tip="No referee or central server to trust — the rules are enforced on-chain by the contract and cryptographic proofs, so neither player can cheat or be cheated." />{" "}
            game implemented in{" "}
            <Term word="Midnight" tip="A privacy-focused blockchain that runs smart contracts with zero-knowledge proofs — keeping data confidential while still publicly verifiable." />{" "}
            with{" "}
            <Term word="ZK Proofs" tip="Zero-knowledge proofs: cryptography that proves a statement is true (e.g. “this move is legal”) without revealing the secret behind it." />.
            <br />
            Place 3 pieces in a row and you win.
          </p>

          {view === "menu" && (
            <>
              {!connected && (
                <p className="muted" style={{ margin: "0 0 10px", fontSize: 13 }}>
                  🔑 Connect a wallet to play — use the <strong>Wallet</strong> button (top-right).
                </p>
              )}
              {relayUp === false && (
                <p className="muted" style={{ margin: "0 0 10px", fontSize: 13 }}>
                  📡 Multiplayer relay offline — <strong>New game</strong>, <strong>Join</strong> and{" "}
                  <strong>Reconnect</strong> need it. <strong>Practice vs AI</strong> runs fully in your browser.
                </p>
              )}
              <div className="choices">
                <button className="btn-x" disabled={relayUp === false} onClick={gated(() => newGame(false))}>New game</button>
                <button className="btn-o" disabled={relayUp === false} onClick={gated(() => { setError(null); setView("join"); })}>Join a game</button>
                <button className="btn-glass" onClick={gated(() => newGame(true))}>🤖 Practice vs AI</button>
                <button className="btn-glass" disabled={relayUp === false} onClick={gated(() => { setError(null); setView("reconnect"); })}>Reconnect</button>
              </div>
            </>
          )}

          {view === "join" && (
            <div className="col" style={{ marginTop: 8 }}>
              <button className="back-link" onClick={() => setView("menu")}>← back</button>
              <p className="muted" style={{ margin: 0 }}>
                Paste the game id X shared. You generate your own keys and submit them — a tampered game
                fails the join and costs you nothing.
              </p>
              <div className="field">
                <input type="text" value={joinId} onChange={(e) => setJoinId(e.target.value)} placeholder="game id (64 hex chars)" />
                <button className="btn-o" onClick={joinGame} disabled={!joinId.trim()}>Join</button>
              </div>
            </div>
          )}

          {view === "reconnect" && (
            <div className="col" style={{ marginTop: 8 }}>
              <button className="back-link" onClick={() => setView("menu")}>← back</button>
              {saved.length === 0 && <p className="muted" style={{ margin: 0 }}>No saved sessions in this browser yet.</p>}
              <div className="session-list">
                {saved.map((e) => (
                  <div key={e.addr + e.role} className="session">
                    <span className={`role-chip ${e.role}`}>{colorOfRole(e.role)}</span>
                    <div className="meta">
                      <code>{e.addr.slice(0, 14)}…{e.addr.slice(-6)}</code>
                      <div className="sub">{timeAgo(e.updatedAt)} · {states[e.addr] ?? "checking…"}</div>
                    </div>
                    <button className="btn-glass btn-sm" onClick={() => reconnect(e.addr, e.role)}>Resume</button>
                    <button className="btn-glass btn-sm session-del" title="Remove from this browser" onClick={() => removeSession(e.addr, e.role)}>✕</button>
                  </div>
                ))}
              </div>
              <p className="muted" style={{ margin: "8px 0 0" }}>…or reconnect by id:</p>
              <div className="field">
                <input type="text" value={reconId} onChange={(e) => setReconId(e.target.value)} placeholder="game id (64 hex chars)" />
                <div className="seg">
                  <button className={reconRole === "x" ? "active x" : ""} onClick={() => setReconRole("x")}>RED</button>
                  <button className={reconRole === "o" ? "active o" : ""} onClick={() => setReconRole("o")}>BLUE</button>
                </div>
                <button className="btn-glass" onClick={() => reconnect(reconId, reconRole)} disabled={!reconId.trim()}>Resume</button>
              </div>
            </div>
          )}

          {error && <div className="error">{error}</div>}

          <p className="repo-note">
            Check out the full source code at{" "}
            <a href="https://github.com/effectstream/nix-nax" target="_blank" rel="noreferrer">
              github.com/effectstream/nix-nax
            </a>
          </p>
        </div>
      </div>

      {busy && (
        <div className="loading-overlay">
          <div className="loading-card glass">
            <div className="spinner" />
            <div>{busy}</div>
            <div className="muted" style={{ fontSize: 12 }}>This can take a few seconds.</div>
          </div>
        </div>
      )}
    </div>
  );
}
