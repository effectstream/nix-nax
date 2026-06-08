// HTTP client for the relay's on-chain action API.
// All endpoints proxied via vite (5173 -> 4310).

type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

async function post<T>(path: string, body: Json): Promise<T> {
  const r = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok || data?.ok === false) {
    throw new Error(data?.error ?? `HTTP ${r.status}`);
  }
  return data as T;
}
async function get<T>(path: string): Promise<T> {
  const r = await fetch(path);
  const data = await r.json();
  if (!r.ok || data?.ok === false) {
    throw new Error(data?.error ?? `HTTP ${r.status}`);
  }
  return data as T;
}

export interface ContractState {
  ok: true;
  contractAddress: string;
  status: number;             // 0=halfOpen, 1=inProgress, 2=settled
  statusName: "halfOpen" | "inProgress" | "settled";
  winner: number;             // 0=none, 1=x, 2=o, 3=draw
  winnerName: "none" | "x" | "o" | "draw";
  idX: string;                // hex
  idO: string;                // hex (zeros until O joins)
  rootX: string;              // bigint string ("0x…")
  rootO: string;              // bigint string ("0x…")
  committedTurns: number;
  turnMark: number;
  hasChallenge: boolean;
  challengeUntil: string;
  hasDeadline: boolean;
  deadline: string;
}

export const api = {
  health: () => get<{ ok: true }>("/api/health"),
  deploy: (args: { idX: string; rootX: string }) =>
    post<{ ok: true; contractAddress: string }>("/api/deploy", args),
  join: (args: { addr: string; idO: string; rootO: string }) =>
    post<{ ok: true; txId: string }>("/api/join", args),
  state: (addr: string) => get<ContractState>(`/api/state/${addr}`),
  settle: (body: {
    addr: string; secret: string;
    nMoves: number; cells: number[]; secrets: string[];
    paths: { leaf: string; path: { sibling: string; goes_left: boolean }[] }[];
    untilTime: string;
  }) => post<{ ok: true; txId: string }>("/api/settle", body),
  claimResult: (addr: string) => post<{ ok: true; txId: string }>("/api/claim-result", { addr }),
  startTimeout: (addr: string, secret: string, untilTime: string) =>
    post<{ ok: true; txId: string }>("/api/start-timeout", { addr, secret, untilTime }),
  claimTimeout: (addr: string) => post<{ ok: true; txId: string }>("/api/claim-timeout", { addr }),
  proveFraud: (body: {
    addr: string; side: "x" | "o"; turn: number;
    cellA: number; secretA: string; pathA: { leaf: string; path: { sibling: string; goes_left: boolean }[] };
    cellB: number; secretB: string; pathB: { leaf: string; path: { sibling: string; goes_left: boolean }[] };
  }) => post<{ ok: true; txId: string }>("/api/prove-fraud", body),
};
