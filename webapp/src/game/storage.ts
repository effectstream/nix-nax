// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

// localStorage save/restore. Each game ID and player role gets its own key. The game
// identity and Merkle secrets cannot be recovered from the chain, so unfinished
// sessions are never evicted automatically. Removal is an explicit lobby action.

import type { SerializedSession } from "./player-session.ts";
import { isQuotaError } from "./quota.ts";

type Role = "x" | "o";
const KEY = (gameId: string, role: Role) => `nixnax:session:${gameId}:${role}`;
const INDEX = "nixnax:sessions:index";

export interface IndexEntry { addr: string; role: Role; updatedAt?: number }

export class SessionPersistenceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SessionPersistenceError";
  }
}

function persistenceError(e: unknown): SessionPersistenceError {
  const detail = e instanceof Error ? ` (${e.message})` : "";
  const reason = isQuotaError(e) ? "browser storage is full" : "browser storage is unavailable";
  return new SessionPersistenceError(
    `Cannot save the private game credentials because ${reason}${detail}. Remove a finished game from Reconnect or free site storage, then try again.`,
    { cause: e },
  );
}

function restoreItem(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Best effort only. A failed replacement leaves the previous value intact in
    // conforming Web Storage implementations; this covers test doubles too.
  }
}

function readIndex(): IndexEntry[] {
  try {
    const raw = localStorage.getItem(INDEX);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as IndexEntry[] | string[];
    if (!Array.isArray(parsed) || parsed.length === 0) return [];
    if (typeof parsed[0] === "string") {
      return (parsed as string[]).map((addr) => ({ addr, role: "x" as Role }));
    }
    return (parsed as IndexEntry[]).filter(
      (e) => e && typeof e.addr === "string" && (e.role === "x" || e.role === "o"),
    );
  } catch {
    return [];
  }
}

function storedSessionEntries(): IndexEntry[] {
  try {
    const entries: IndexEntry[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      const match = key?.match(/^nixnax:session:([^:]+):(x|o)$/);
      if (!key || !match || localStorage.getItem(key) === null) continue;
      entries.push({ addr: match[1], role: match[2] as Role });
    }
    return entries;
  } catch {
    return [];
  }
}

// Historical entry point retained for old callers. It now repairs the small
// convenience index only; it never deletes human or AI credentials.
export function pruneSavedGames(): void {
  const previous = localStorage.getItem(INDEX);
  try {
    localStorage.setItem(INDEX, JSON.stringify(listSessions()));
  } catch (e) {
    restoreItem(INDEX, previous);
    throw persistenceError(e);
  }
}

export function saveSession(s: SerializedSession): void {
  const key = KEY(s.gameId, s.role);
  const data = JSON.stringify(s);
  let previousSession: string | null;
  let previousIndex: string | null;
  try {
    previousSession = localStorage.getItem(key);
    previousIndex = localStorage.getItem(INDEX);
  } catch (e) {
    throw persistenceError(e);
  }
  try {
    localStorage.setItem(key, data);
    const idx = listSessions().filter((e) => !(e.addr === s.gameId && e.role === s.role));
    idx.push({ addr: s.gameId, role: s.role, updatedAt: Date.now() });
    localStorage.setItem(INDEX, JSON.stringify(idx));
  } catch (e) {
    restoreItem(key, previousSession);
    restoreItem(INDEX, previousIndex);
    throw persistenceError(e);
  }
}

export function loadSession(addr: string, role?: Role): SerializedSession | null {
  if (role) {
    try {
      const raw = localStorage.getItem(KEY(addr, role));
      return raw ? (JSON.parse(raw) as SerializedSession) : null;
    } catch {
      return null;
    }
  }
  // Backward-compat: try O first (the lobby Join-as-O button), then X.
  return loadSession(addr, "o") ?? loadSession(addr, "x");
}

// Strict read used before a join attempt. A corrupt record is evidence that
// credentials existed, so treating it as absent and overwriting it would turn a
// recoverable/manual-export problem into permanent loss.
export function loadSessionForUpdate(addr: string, role: Role): SerializedSession | null {
  try {
    const raw = localStorage.getItem(KEY(addr, role));
    if (raw === null) return null;
    return JSON.parse(raw) as SerializedSession;
  } catch (error) {
    throw new SessionPersistenceError(
      "Saved private game credentials exist but cannot be read. They were not overwritten; repair or explicitly remove that saved session before joining again.",
      { cause: error },
    );
  }
}

export function listSessions(): IndexEntry[] {
  const indexed = readIndex();
  const timestamps = new Map(indexed.map((e) => [`${e.addr}:${e.role}`, e.updatedAt]));
  return storedSessionEntries()
    .map((e) => ({ ...e, updatedAt: timestamps.get(`${e.addr}:${e.role}`) }))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
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
const AI_KEY = (gameId: string) => `ai-o:${gameId}`;
const vsAiSet = (): string[] => {
  try { return JSON.parse(localStorage.getItem(VSAI) ?? "[]") as string[]; } catch { return []; }
};
export function markVsAi(gameId: string): void {
  const s = new Set(vsAiSet());
  s.add(gameId);
  try {
    localStorage.setItem(VSAI, JSON.stringify([...s]));
  } catch (e) {
    throw persistenceError(e);
  }
}
export function isVsAi(gameId: string): boolean {
  return vsAiSet().includes(gameId);
}
export function clearVsAi(gameId: string): void {
  localStorage.setItem(VSAI, JSON.stringify(vsAiSet().filter((g) => g !== gameId)));
  localStorage.removeItem(AI_KEY(gameId));
}

export function loadAiSession(gameId: string): SerializedSession | null {
  try {
    const raw = localStorage.getItem(AI_KEY(gameId));
    return raw ? (JSON.parse(raw) as SerializedSession) : null;
  } catch (error) {
    throw new SessionPersistenceError(
      "Saved private AI credentials exist but cannot be read. They were not overwritten; repair or explicitly remove that saved practice game before reconnecting.",
      { cause: error },
    );
  }
}

export function saveAiSession(gameId: string, session: SerializedSession): void {
  const key = AI_KEY(gameId);
  let previous: string | null;
  try {
    previous = localStorage.getItem(key);
  } catch (e) {
    throw persistenceError(e);
  }
  try {
    localStorage.setItem(key, JSON.stringify(session));
  } catch (e) {
    restoreItem(key, previous);
    throw persistenceError(e);
  }
}
