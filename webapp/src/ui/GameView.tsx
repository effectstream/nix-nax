import { useEffect, useMemo, useRef, useState } from "react";
import Board from "./Board.tsx";
import StatusPanel from "./StatusPanel.tsx";
import ActionsPanel from "./ActionsPanel.tsx";
import EventLog, { type LogEntry } from "./EventLog.tsx";
import { api, type ContractState } from "../api/http.ts";
import { connectRelay, type RelayClient } from "../api/ws.ts";
import {
  deserialiseMove,
  PlayerSession,
  serialiseMove,
} from "../game/player-session.ts";
import { saveSession } from "../game/storage.ts";

const hexToBytes = (s: string): Uint8Array => {
  const h = (s.startsWith("0x") ? s.slice(2) : s).match(/.{1,2}/g) ?? [];
  return new Uint8Array(h.map((b) => parseInt(b, 16)));
};

interface Props {
  session: PlayerSession;
  onLeave: () => void;
}

const ts = () => new Date().toISOString().slice(11, 19);

export default function GameView({ session, onLeave }: Props) {
  const [chain, setChain] = useState<ContractState | null>(null);
  const [wsStatus, setWsStatus] = useState<"connecting" | "open" | "closed">("connecting");
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [, force] = useState(0);
  const log = (msg: string) => setEntries((es) => [...es, { ts: ts(), msg }]);

  // Holds the WS client across re-renders.
  const relayRef = useRef<RelayClient | null>(null);

  // Subscribe to relay + start polling chain state.
  useEffect(() => {
    log(`role=${session.role.toUpperCase()}, addr=${session.contractAddress.slice(0, 16)}…`);
    const client = connectRelay(
      session.contractAddress,
      session.role,
      (msg) => {
        if (msg.type === "joined") log(`opponent (${msg.role}) joined`);
        else if (msg.type === "left") log(`peer (${msg.role}) left`);
        else if (msg.type === "event") log(`chain event: ${msg.kind}`);
        else if (msg.type === "move") {
          const m = deserialiseMove(msg.payload);
          const r = session.receiveMove(m);
          if (!r.ok) log(`! received invalid move: ${r.reason}`);
          else {
            log(`<- move turn=${m.turn} cell=${m.cell} (${session.role === "x" ? "O" : "X"})`);
            saveSession(session.serialise());
            force((x) => x + 1);
          }
        }
      },
      (s) => setWsStatus(s),
    );
    relayRef.current = client;
    return () => client.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.contractAddress, session.role]);

  // Poll on-chain state every 3 s. When the chain reveals the OPPONENT's
  // commitments (e.g. after O joins from another tab), populate the local
  // session so SignedMove verification works.
  useEffect(() => {
    let running = true;
    const tick = async () => {
      try {
        const s = await api.state(session.contractAddress);
        if (running) {
          setChain(s);
          if (!session.opponentInfo) {
            const oppRoleIsX = session.role === "o";
            const idHex   = oppRoleIsX ? s.idX : s.idO;
            const rootHex = oppRoleIsX ? s.rootX : s.rootO;
            const idBytes = hexToBytes(idHex);
            const rootBig = BigInt(rootHex);
            const isZero = rootBig === 0n && idBytes.every((b) => b === 0);
            if (!isZero) {
              session.setOpponent({ id: idBytes, root: rootBig });
              log(`opponent commitments fetched from chain (${oppRoleIsX ? "X" : "O"})`);
              force((x) => x + 1);
            }
          }
        }
      } catch (e) {
        if (running) log(`! state poll error: ${(e as Error).message}`);
      }
    };
    tick();
    const id = setInterval(tick, 3000);
    return () => { running = false; clearInterval(id); };
  }, [session.contractAddress]);

  const myTurn = useMemo(() => {
    return session.gameStatus !== "ended" && session.nextTurnRole === session.role;
  }, [session, entries.length]);

  const onCellClick = (cell: number) => {
    try {
      const move = session.myMove(cell);
      log(`-> move turn=${move.turn} cell=${move.cell} (${session.role.toUpperCase()})`);
      saveSession(session.serialise());
      relayRef.current?.send({
        type: "move",
        addr: session.contractAddress,
        payload: serialiseMove(move),
      });
      force((x) => x + 1);
    } catch (e) {
      log(`! ${(e as Error).message}`);
    }
  };

  return (
    <div className="layout">
      <div className="spread">
        <div>
          <h1>Channel · {session.contractAddress.slice(0, 12)}…</h1>
          <p className="subtitle">You are playing as <strong>{session.role.toUpperCase()}</strong></p>
        </div>
        <button onClick={onLeave}>← Back to lobby</button>
      </div>

      <div className="card">
        <Board
          board={session.boardState}
          onCellClick={onCellClick}
          disabled={!myTurn}
        />
        <div style={{ textAlign: "center", color: "var(--fg-1)", marginTop: 8, fontSize: 13 }}>
          {session.gameStatus === "ended"
            ? "Local game finished. Settle on-chain to record the result."
            : myTurn ? "Your turn — click a cell." : "Waiting for opponent…"}
        </div>
      </div>

      <div className="flex-2col">
        <StatusPanel session={session} chain={chain} wsStatus={wsStatus} />
        <ActionsPanel
          session={session}
          chain={chain}
          log={log}
          onRefresh={async () => {
            try {
              setChain(await api.state(session.contractAddress));
            } catch {}
          }}
        />
      </div>

      <EventLog entries={entries} />
    </div>
  );
}
