import { useEffect, useState } from "react";
import { api } from "../api/http.ts";
import { generatePlayerKeys, PlayerSession } from "../game/player-session.ts";
import { listSessions, loadSession, saveSession } from "../game/storage.ts";

export interface HomeProps {
  onOpen: (session: PlayerSession) => void;
}

const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");

type Role = "x" | "o";
interface IndexEntry { addr: string; role: Role }

export default function Home({ onOpen }: HomeProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [joinAddr, setJoinAddr] = useState("");
  const [saved, setSaved] = useState<IndexEntry[]>([]);
  const [importJson, setImportJson] = useState("");

  useEffect(() => {
    setSaved(listSessions());
  }, []);

  // Phase 1: X deploys with their own commitments only. Channel is halfOpen
  // until O calls Join. X persists only THEIR side to localStorage.
  const openAsX = async () => {
    setError(null);
    setBusy("Deploying contract…");
    try {
      const x = generatePlayerKeys("x");
      const res = await api.deploy({
        idX: hex(x.id),
        rootX: "0x" + x.tokenTree.root.field.toString(16),
      });
      // No opponent info yet — populated when O calls join. Pass null for now.
      const xSession = new PlayerSession("x", res.contractAddress, x, null);
      saveSession(xSession.serialise());
      onOpen(xSession);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  // Phase 2: O joins by submitting their own commitments. Then verifies the
  // on-chain idO/rootO match (catches front-running).
  const joinAsO = async () => {
    setError(null);
    if (!joinAddr) { setError("contract address required"); return; }
    setBusy("Joining channel…");
    try {
      const o = generatePlayerKeys("o");
      const addr = joinAddr.trim();
      const myIdHex = hex(o.id);
      const myRootHex = "0x" + o.tokenTree.root.field.toString(16);

      try {
        await api.join({ addr, idO: myIdHex, rootO: myRootHex });
      } catch (e) {
        // If join fails because someone already joined, check whether THEIR
        // creds match ours (then the join was effectively idempotent) or are
        // different (front-running detected).
        const state = await api.state(addr);
        if (state.status === 0) {
          throw new Error(`join failed: ${(e as Error).message}`);
        }
        const chainIdHex = (state as any).idO ?? "";
        if (chainIdHex.toLowerCase() === myIdHex.toLowerCase()) {
          // Effectively idempotent.
        } else {
          throw new Error("⚠️ contract already joined with DIFFERENT credentials — possible front-run. Walk away.");
        }
      }

      // Sanity-verify the on-chain state matches what we just submitted.
      const state = await api.state(addr);
      // (Relay's state endpoint doesn't return idO/rootO directly today; we
      // just check status flipped to inProgress.)
      if (state.status !== 1) {
        throw new Error(`expected status=inProgress after join; got status=${state.status}`);
      }

      // We don't know X's id/root from on-chain (the state endpoint omits
      // them in this revision) — but the contract enforces that revealed
      // X-tokens must verify under the on-chain rootX, so a bogus X player
      // can't make a move anyway. For dispute-grade verification, the X
      // commitments could be fetched via queryContractState.
      const oSession = new PlayerSession("o", addr, o, null);
      saveSession(oSession.serialise());
      onOpen(oSession);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const restoreAs = (addr: string, role: Role) => {
    setError(null);
    const stored = loadSession(addr.trim(), role);
    if (!stored) {
      setError(`No saved ${role.toUpperCase()} session for this address.`);
      return;
    }
    onOpen(PlayerSession.restore(stored));
  };

  const importPasted = () => {
    setError(null);
    if (!importJson.trim()) { setError("paste the session JSON first"); return; }
    try {
      const parsed = JSON.parse(importJson);
      if (!parsed || typeof parsed !== "object" || !parsed.contractAddress || !parsed.role) {
        throw new Error("not a SerializedSession (missing contractAddress / role)");
      }
      const session = PlayerSession.restore(parsed);
      saveSession(session.serialise());
      onOpen(session);
    } catch (e) {
      setError(`import failed: ${(e as Error).message}`);
    }
  };

  return (
    <div className="layout">
      <h1>Tic-Tac-Toe state channel</h1>
      <p className="subtitle">Two-phase open: X deploys, O joins, then play.</p>

      <div className="card">
        <h3 style={{ margin: "0 0 12px" }}>Phase 1 · Open a new channel (X)</h3>
        <p style={{ color: "var(--fg-1)", margin: "0 0 12px", fontSize: 13 }}>
          X generates their own keys + token tree and deploys the contract
          with ONLY X's commitments. The channel starts in <code>halfOpen</code>
          state — no settle, no fraud proof — until O joins from their own browser.
        </p>
        <div className="row">
          <button className="primary" onClick={openAsX} disabled={busy !== null}>
            {busy ?? "Open new channel (X)"}
          </button>
        </div>
      </div>

      <div className="card">
        <h3 style={{ margin: "0 0 12px" }}>Phase 2 · Join an existing channel (O)</h3>
        <p style={{ color: "var(--fg-1)", margin: "0 0 12px", fontSize: 13 }}>
          O pastes the contract address X shared, generates O's own keys, and
          submits <code>joinChannel(idO, rootO)</code>. If the channel was
          tampered with (front-run), the join fails — you walk away with nothing
          lost.
        </p>
        <div className="col">
          <input
            type="text"
            value={joinAddr}
            onChange={(e) => setJoinAddr(e.target.value)}
            placeholder="contract address (hex)"
          />
          <div className="row">
            <button className="primary" onClick={joinAsO} disabled={!joinAddr || busy !== null}>
              {busy ? busy : "Join as O"}
            </button>
            <button onClick={() => restoreAs(joinAddr, "x")} disabled={!joinAddr}>Restore as X</button>
            <button onClick={() => restoreAs(joinAddr, "o")} disabled={!joinAddr}>Restore as O</button>
          </div>
        </div>
      </div>

      {saved.length > 0 && (
        <div className="card">
          <h3 style={{ margin: "0 0 12px" }}>Saved sessions</h3>
          <div className="col">
            {saved.map((e) => (
              <div key={e.addr + e.role} className="spread">
                <code style={{ fontSize: 12 }}>
                  {e.addr.slice(0, 16)}…{e.addr.slice(-8)} · {e.role.toUpperCase()}
                </code>
                <button onClick={() => restoreAs(e.addr, e.role)}>Restore</button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <h3 style={{ margin: "0 0 12px" }}>Import session from JSON</h3>
        <p style={{ color: "var(--fg-1)", margin: "0 0 10px", fontSize: 13 }}>
          For migrating a saved session between browsers. Paste a serialized
          PlayerSession JSON to import + play.
        </p>
        <div className="col">
          <textarea
            value={importJson}
            onChange={(e) => setImportJson(e.target.value)}
            placeholder='{ "role": "o", "contractAddress": "...", ... }'
            rows={4}
          />
          <div className="row">
            <button className="primary" onClick={importPasted} disabled={!importJson.trim()}>
              Import &amp; play
            </button>
          </div>
        </div>
      </div>

      {error && <div className="error">{error}</div>}
    </div>
  );
}
