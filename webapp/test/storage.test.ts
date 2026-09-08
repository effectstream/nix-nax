// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SessionPersistenceError,
  isVsAi,
  listSessions,
  loadAiSession,
  loadSession,
  markVsAi,
  pruneSavedGames,
  saveSession,
} from "../src/game/storage.ts";
import type { SerializedSession } from "../src/game/player-session.ts";

class MemoryStorage {
  protected values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
  removeItem(key: string) { this.values.delete(key); }
  clear() { this.values.clear(); }
}

class FailingStorage extends MemoryStorage {
  failKey: string | null = null;
  override setItem(key: string, value: string) {
    if (key === this.failKey) throw Object.assign(new Error("quota reached"), { name: "QuotaExceededError" });
    super.setItem(key, value);
  }
}

const session = (gameId: string, secret = "11".repeat(32)): SerializedSession => ({
  v: 3,
  gameId,
  role: "x",
  secret,
  tokenSecrets: "22".repeat(32),
  indexSecrets: "33".repeat(32),
  indexSlots: [],
  indexBits: [],
  randomValues: "44".repeat(32),
  randomBits: [],
  opponent: null,
  moves: [],
  intents: [],
  reveals: [],
  extraIntents: [],
  extraReveals: [],
});

beforeEach(() => {
  vi.stubGlobal("localStorage", new MemoryStorage());
});

describe("durable game storage", () => {
  it("retains three unfinished identities and their AI state", () => {
    const games = ["01".repeat(32), "02".repeat(32), "03".repeat(32)];
    for (const gameId of games) saveSession(session(gameId));
    localStorage.setItem(`ai-o:${games[0]}`, "private AI state");
    markVsAi(games[0]);

    pruneSavedGames();

    expect(new Set(listSessions().map(({ addr }) => addr))).toEqual(new Set(games));
    expect(loadSession(games[0], "x")?.secret).toBe("11".repeat(32));
    expect(localStorage.getItem(`ai-o:${games[0]}`)).toBe("private AI state");
    expect(isVsAi(games[0])).toBe(true);
  });

  it("reports quota failure and restores the previous durable record", () => {
    const storage = new FailingStorage();
    vi.stubGlobal("localStorage", storage);
    const gameId = "04".repeat(32);
    saveSession(session(gameId, "aa".repeat(32)));
    storage.failKey = "nixnax:sessions:index";

    expect(() => saveSession(session(gameId, "bb".repeat(32))))
      .toThrow(SessionPersistenceError);
    expect(loadSession(gameId, "x")?.secret).toBe("aa".repeat(32));
  });

  it("keeps lobby discovery safe when storage access is blocked", () => {
    const unavailable = {
      get length(): number { throw new DOMException("blocked", "SecurityError"); },
      key: () => { throw new DOMException("blocked", "SecurityError"); },
      getItem: () => { throw new DOMException("blocked", "SecurityError"); },
      setItem: () => { throw new DOMException("blocked", "SecurityError"); },
      removeItem: () => { throw new DOMException("blocked", "SecurityError"); },
      clear: () => { throw new DOMException("blocked", "SecurityError"); },
    };
    vi.stubGlobal("localStorage", unavailable);

    expect(listSessions()).toEqual([]);
    expect(() => saveSession(session("05".repeat(32)))).toThrow(SessionPersistenceError);
  });

  it("preserves a corrupt existing AI identity instead of replacing it", () => {
    const gameId = "06".repeat(32);
    const key = `ai-o:${gameId}`;
    localStorage.setItem(key, "{damaged-private-state");

    expect(() => loadAiSession(gameId)).toThrow("They were not overwritten");
    expect(localStorage.getItem(key)).toBe("{damaged-private-state");
  });
});
