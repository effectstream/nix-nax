import { useEffect, useState } from "react";
import type { ContractState } from "../api/http.ts";
import type { PlayerSession } from "../game/player-session.ts";

const WINNER_LABEL = ["none", "X", "O", "draw"];
const STATUS_LABEL = ["halfOpen (waiting for O)", "in progress", "settled"];

export interface StatusPanelProps {
  session: PlayerSession;
  chain: ContractState | null;
  wsStatus: "connecting" | "open" | "closed";
}

export default function StatusPanel({ session, chain, wsStatus }: StatusPanelProps) {
  const [now, setNow] = useState(Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  const challenge = chain?.hasChallenge
    ? Math.max(0, Number(chain.challengeUntil) - now)
    : null;
  const deadline = chain?.hasDeadline
    ? Math.max(0, Number(chain.deadline) - now)
    : null;

  const wsTag = wsStatus === "open" ? "good" : wsStatus === "connecting" ? "warn" : "bad";

  // X has access to both sides' secrets (they were generated when this tab
  // pressed *Open*). Surface the O credentials so the other player on a
  // different browser can paste-import them.
  const exportOpponent = () => {
    const otherRole = session.role === "x" ? "o" : "x";
    const raw = localStorage.getItem(`ttt:session:${session.contractAddress}:${otherRole}`);
    if (!raw) {
      alert(`No saved ${otherRole.toUpperCase()} session found in this browser.`);
      return;
    }
    navigator.clipboard.writeText(raw).then(
      () => alert(`${otherRole.toUpperCase()} session JSON copied — paste it into the other browser's lobby.`),
      () => prompt(`Copy this ${otherRole.toUpperCase()} session JSON:`, raw),
    );
  };

  return (
    <div className="card">
      <h3 style={{ margin: "0 0 12px" }}>Status</h3>
      <div className="kvs">
        <div className="k">Contract</div>
        <div className="v">
          {session.contractAddress.slice(0, 16)}…{session.contractAddress.slice(-8)}
          <button
            className="copy-btn"
            onClick={() => navigator.clipboard.writeText(session.contractAddress)}
          >
            copy
          </button>
        </div>
        <div className="k">My role</div>
        <div className="v">{session.role.toUpperCase()}</div>
        <div className="k">Relay</div>
        <div className="v"><span className={`tag ${wsTag}`}>{wsStatus}</span></div>
        <div className="k">Local turn</div>
        <div className="v">
          {session.gameStatus === "ended"
            ? `local game ended (winner: ${WINNER_LABEL[session.winnerLocal === "draw" ? 3 : session.winnerLocal] ?? "?"})`
            : `turn ${session.committedTurns} (${session.nextTurnRole.toUpperCase()})`}
        </div>
        <div className="k">On-chain status</div>
        <div className="v">{chain ? STATUS_LABEL[chain.status] ?? `?(${chain.status})` : "—"}</div>
        <div className="k">On-chain winner</div>
        <div className="v">
          {chain ? (
            chain.winner === 0 ? "—" : (
              <span className={`tag ${chain.winner === 3 ? "warn" : "good"}`}>{WINNER_LABEL[chain.winner]}</span>
            )
          ) : "—"}
        </div>
        <div className="k">Committed turns</div>
        <div className="v">{chain?.committedTurns ?? "—"}</div>
        <div className="k">Turn-mark</div>
        <div className="v">{chain ? (chain.turnMark === 1 ? "X" : chain.turnMark === 2 ? "O" : chain.turnMark) : "—"}</div>
        {challenge !== null && (
          <>
            <div className="k">Challenge window</div>
            <div className="v">
              {challenge > 0 ? (
                <span className="tag warn">{challenge}s left</span>
              ) : (
                <span className="tag good">expired — claim result</span>
              )}
            </div>
          </>
        )}
        {deadline !== null && (
          <>
            <div className="k">Timeout deadline</div>
            <div className="v">
              {deadline > 0 ? (
                <span className="tag warn">{deadline}s left</span>
              ) : (
                <span className="tag good">expired — claim forfeit</span>
              )}
            </div>
          </>
        )}
      </div>
      <div style={{ marginTop: 12 }}>
        <button onClick={exportOpponent}>
          Copy {session.role === "x" ? "O" : "X"} session JSON (for the other browser)
        </button>
      </div>
    </div>
  );
}
