// localStorage save/restore. Each contract address gets its own key.
// SECURITY NOTE: this stores the player's identity secret unencrypted —
// local-dev only.

import type { SerializedSession } from "./player-session.ts";
import { isQuotaError, pruneAiSessions } from "./quota.ts";

type Role = "x" | "o";
const KEY = (gameId: string, role: Role) => `nixnax:session:${gameId}:${role}`;
const INDEX = "nixnax:sessions:index";

export interface IndexEntry { addr: string; role: Role; updatedAt?: number }

// Retain only the current game plus one previous — each serialized session is
// ~0.8 MB (see quota.ts), so unbounded saves blow the localStorage quota. A
// "game" is a gameId; older games are evicted whole: BOTH players' sessions,
// the AI blob, and the index / vs-AI membership. With `current` given it is
// always kept (even before its own write); without it (app startup) we simply
// keep the MAX_GAMES most-recently-updated games.
const MAX_GAMES = 2;

function enforceRetention(current?: string): void {
  const keep = new Set<string>();
  if (current) keep.add(current);
  for (const e of listSessions()) {            // newest-first
    if (keep.size >= MAX_GAMES) break;
    keep.add(e.addr);
  }
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (!k) continue;
    const m = k.match(/^nixnax:session:([^:]+):(?:x|o)$/);
    if (m) { if (!keep.has(m[1])) localStorage.removeItem(k); continue; }
    if (k.startsWith("ai-o:") && !keep.has(k.slice(5))) localStorage.removeItem(k);
  }
  const idx = listSessions().filter((e) => keep.has(e.addr));
  localStorage.setItem(INDEX, JSON.stringify(idx));
  const vs = vsAiSet();
  const trimmed = vs.filter((g) => keep.has(g));
  if (trimmed.length !== vs.length) localStorage.setItem(VSAI, JSON.stringify(trimmed));
}

// Drop everything but the MAX_GAMES most-recent games. Call once on app load so
// pre-existing bloat is cleaned even before the first save.
export function pruneSavedGames(): void {
  enforceRetention();
}

export function saveSession(s: SerializedSession): void {
  const key = KEY(s.gameId, s.role);
  enforceRetention(s.gameId);                  // bound to current + one previous, freeing old games first
  const data = JSON.stringify(s);
  try {
    localStorage.setItem(key, data);
  } catch (e) {
    if (!isQuotaError(e)) throw e;
    // Even within the 2-game cap a write can fail; drop the previous game's AI
    // blob (largest throwaway) and retry, then give up gracefully, never crash.
    pruneAiSessions(new Set([`ai-o:${s.gameId}`]));
    try {
      localStorage.setItem(key, data);
    } catch (e2) {
      if (!isQuotaError(e2)) throw e2;
      console.warn("storage full — this game could not be saved for reconnect");
      return;
    }
  }
  const idx = listSessions().filter((e) => !(e.addr === s.gameId && e.role === s.role));
  idx.push({ addr: s.gameId, role: s.role, updatedAt: Date.now() });
  localStorage.setItem(INDEX, JSON.stringify(idx));
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
  // Old format was string[]; convert (no timestamps).
  if (typeof parsed[0] === "string") {
    return (parsed as string[]).map((addr) => ({ addr, role: "x" as Role }));
  }
  // Newest first when timestamps are present.
  return (parsed as IndexEntry[]).slice().sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

export function dropSession(addr: string, role: Role): void {
  localStorage.removeItem(KEY(addr, role));
  const idx = listSessions().filter((e) => !(e.addr === addr && e.role === role));
  localStorage.setItem(INDEX, JSON.stringify(idx));
}

// ── "Practice vs AI" games ────────────────────────────────────────────────
// A set of gameIds the local AI plays as O. Kept separate from the session
// index so the AI's own O session (stored under `ai-o:<gameId>`) never clutters
// the human's Reconnect list. `isVsAi` lets a reconnected X game restart the AI.
const VSAI = "nixnax:vsai";
const vsAiSet = (): string[] => {
  try { return JSON.parse(localStorage.getItem(VSAI) ?? "[]") as string[]; } catch { return []; }
};
export function markVsAi(gameId: string): void {
  const s = new Set(vsAiSet());
  s.add(gameId);
  localStorage.setItem(VSAI, JSON.stringify([...s]));
}
export function isVsAi(gameId: string): boolean {
  return vsAiSet().includes(gameId);
}
export function clearVsAi(gameId: string): void {
  localStorage.setItem(VSAI, JSON.stringify(vsAiSet().filter((g) => g !== gameId)));
  localStorage.removeItem(`ai-o:${gameId}`);
}
