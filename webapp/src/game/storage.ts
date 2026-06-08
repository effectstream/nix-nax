// localStorage save/restore. Each contract address gets its own key.
// SECURITY NOTE: this stores the player's identity secret unencrypted —
// local-dev only.

import type { SerializedSession } from "./player-session.ts";

type Role = "x" | "o";
const KEY = (addr: string, role: Role) => `ttt:session:${addr}:${role}`;
const INDEX = "ttt:sessions:index";

interface IndexEntry { addr: string; role: Role }

export function saveSession(s: SerializedSession): void {
  localStorage.setItem(KEY(s.contractAddress, s.role), JSON.stringify(s));
  const idx = listSessions();
  if (!idx.some((e) => e.addr === s.contractAddress && e.role === s.role)) {
    idx.push({ addr: s.contractAddress, role: s.role });
    localStorage.setItem(INDEX, JSON.stringify(idx));
  }
}

export function loadSession(addr: string, role?: Role): SerializedSession | null {
  if (role) {
    const raw = localStorage.getItem(KEY(addr, role));
    return raw ? (JSON.parse(raw) as SerializedSession) : null;
  }
  // Backward-compat: try O first (the lobby Join-as-O button), then X.
  return loadSession(addr, "o") ?? loadSession(addr, "x");
}

export function listSessions(): IndexEntry[] {
  const raw = localStorage.getItem(INDEX);
  if (!raw) return [];
  const parsed = JSON.parse(raw) as IndexEntry[] | string[];
  if (parsed.length === 0) return [];
  // Old format was string[]; convert.
  if (typeof parsed[0] === "string") {
    return (parsed as string[]).map((addr) => ({ addr, role: "x" as Role }));
  }
  return parsed as IndexEntry[];
}

export function dropSession(addr: string, role: Role): void {
  localStorage.removeItem(KEY(addr, role));
  const idx = listSessions().filter((e) => !(e.addr === addr && e.role === role));
  localStorage.setItem(INDEX, JSON.stringify(idx));
}
