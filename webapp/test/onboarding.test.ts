// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDurableGame, joinDurably, prepareJoin } from "../src/game/onboarding.ts";
import { loadSession, saveSession } from "../src/game/storage.ts";
import type { PlayerSession, SerializedSession } from "../src/game/player-session.ts";

class MemoryStorage {
  protected values = new Map<string, string>();
  failSessions = false;
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) {
    if (this.failSessions && key.startsWith("nixnax:session:")) {
      throw Object.assign(new Error("full"), { name: "QuotaExceededError" });
    }
    this.values.set(key, String(value));
  }
  removeItem(key: string) { this.values.delete(key); }
  clear() { this.values.clear(); }
}

const serialized = (gameId: string, role: "x" | "o", secret: string): SerializedSession => ({
  v: 3,
  gameId,
  role,
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

function fakeSession(gameId: string, role: "x" | "o", idByte: number, secret = "11".repeat(32)): PlayerSession {
  return {
    gameId,
    role,
    keys: {
      id: new Uint8Array(32).fill(idByte),
      tokenTree: { root: { field: 123n } },
    },
    serialise: () => serialized(gameId, role, secret),
  } as unknown as PlayerSession;
}

beforeEach(() => {
  vi.stubGlobal("localStorage", new MemoryStorage());
});

describe("durable create and join", () => {
  it("persists creator credentials before calling submit", async () => {
    const gameId = "10".repeat(32);
    const session = fakeSession(gameId, "x", 0x11);
    const submit = vi.fn(async () => {
      expect(loadSession(gameId, "x")?.secret).toBe("11".repeat(32));
      return { via: "local" as const, txId: "tx-create" };
    });

    await expect(createDurableGame(session, submit, false)).resolves.toMatchObject({ txId: "tx-create" });
    expect(submit).toHaveBeenCalledOnce();
  });

  it("retains creator credentials when submission outcome is uncertain", async () => {
    const gameId = "11".repeat(32);
    const session = fakeSession(gameId, "x", 0x11);

    await expect(createDurableGame(session, async () => { throw new Error("indexer timeout"); }, false))
      .rejects.toThrow("credentials remain saved");
    expect(loadSession(gameId, "x")?.secret).toBe("11".repeat(32));
  });

  it("prevents submission when the initial durable write fails", async () => {
    const storage = new MemoryStorage();
    storage.failSessions = true;
    vi.stubGlobal("localStorage", storage);
    const submit = vi.fn();

    await expect(createDurableGame(fakeSession("12".repeat(32), "x", 0x12), submit, false))
      .rejects.toThrow("No transaction was submitted");
    expect(submit).not.toHaveBeenCalled();
  });

  it("reuses an existing join identity and reconciles an idempotent retry", async () => {
    const gameId = "13".repeat(32);
    const existing = fakeSession(gameId, "o", 0x5a, "ab".repeat(32));
    saveSession(existing.serialise());
    const create = vi.fn(() => fakeSession(gameId, "o", 0xff));
    const prepared = prepareJoin(gameId, create, () => existing);
    const submit = vi.fn(async () => { throw new Error("already joined"); });

    const result = await joinDurably(
      prepared,
      submit,
      async () => ({ status: 1, idO: "5a".repeat(32) }),
    );

    expect(prepared.reused).toBe(true);
    expect(create).not.toHaveBeenCalled();
    expect(result).toEqual({ result: null, reconciled: true });
    expect(loadSession(gameId, "o")?.secret).toBe("ab".repeat(32));
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ idO: "5a".repeat(32) }));
  });

  it("does not overwrite a corrupt existing join record", () => {
    const gameId = "14".repeat(32);
    const key = `nixnax:session:${gameId}:o`;
    localStorage.setItem(key, "{not-json");
    const create = vi.fn(() => fakeSession(gameId, "o", 0xee));

    expect(() => prepareJoin(gameId, create)).toThrow("They were not overwritten");
    expect(create).not.toHaveBeenCalled();
    expect(localStorage.getItem(key)).toBe("{not-json");
  });
});
