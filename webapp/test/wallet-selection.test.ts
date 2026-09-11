// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connectWallet: vi.fn(),
  logEvent: vi.fn(),
}));

vi.mock("../src/wallet/connector.ts", () => ({
  connectWallet: mocks.connectWallet,
  listWallets: vi.fn(() => []),
  hasWalletExtension: vi.fn(() => false),
}));
vi.mock("../src/game/log-store.ts", () => ({ logEvent: mocks.logEvent }));

import {
  beginWalletSelection,
  connect,
  disconnect,
  finishWalletSelection,
  walletApi,
  walletStateSnapshot,
} from "../src/wallet/useWallet.ts";

class MemoryStorage {
  values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
  removeItem(key: string) { this.values.delete(key); }
  clear() { this.values.clear(); }
}

const wallet = (name: string) => ({ rdns: name, name, icon: "", apiVersion: "1" });
const api = (networkId = "undeployed") => ({
  getConfiguration: vi.fn(async () => ({
    networkId,
    indexerUri: "http://indexer",
    indexerWsUri: "ws://indexer",
    substrateNodeUri: "http://node",
  })),
  getUnshieldedAddress: vi.fn(async () => ({ unshieldedAddress: "addr" })),
  getDustBalance: vi.fn(async () => ({ cap: 1n, balance: 1n })),
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", new MemoryStorage());
  mocks.connectWallet.mockReset();
  mocks.logEvent.mockReset();
  disconnect();
});

describe("wallet selection generations", () => {
  it("does not connect when wallet configuration cannot be read", async () => {
    const candidate = api();
    candidate.getConfiguration.mockRejectedValueOnce(new Error("configuration unavailable"));
    mocks.connectWallet.mockResolvedValueOnce(candidate);

    await connect(wallet("broken") as never);

    expect(walletApi()).toBeNull();
    expect(walletStateSnapshot().connecting).toBe(false);
    expect(mocks.logEvent).toHaveBeenCalledWith(expect.stringContaining("configuration unavailable"));
  });

  it("rejects a wallet on a different network", async () => {
    mocks.connectWallet.mockResolvedValueOnce(api("preview"));

    await connect(wallet("wrong-network") as never);

    expect(walletApi()).toBeNull();
    expect(walletStateSnapshot().connecting).toBe(false);
    expect(mocks.logEvent).toHaveBeenCalledWith(expect.stringContaining("wallet on network \"preview\""));
  });

  it("prevents a late older connection from replacing the latest selection", async () => {
    const firstConfig = deferred<Awaited<ReturnType<ReturnType<typeof api>["getConfiguration"]>>>();
    const first = api();
    first.getConfiguration.mockReturnValueOnce(firstConfig.promise);
    const second = api();
    mocks.connectWallet.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    const oldAttempt = connect(wallet("first") as never);
    await vi.waitFor(() => expect(first.getConfiguration).toHaveBeenCalledOnce());
    await connect(wallet("second") as never);
    firstConfig.resolve({
      networkId: "undeployed",
      indexerUri: "http://indexer",
      indexerWsUri: "ws://indexer",
      substrateNodeUri: "http://node",
    });
    await oldAttempt;

    expect(walletApi()).toBe(second);
    expect(walletStateSnapshot().name).toBe("second");
  });

  it("finishes a failed or null local selection without clearing a newer attempt", () => {
    const old = beginWalletSelection();
    finishWalletSelection(old);
    expect(walletStateSnapshot().connecting).toBe(false);

    const superseded = beginWalletSelection();
    const current = beginWalletSelection();
    finishWalletSelection(superseded);
    expect(walletStateSnapshot().connecting).toBe(true);
    finishWalletSelection(current);
    expect(walletStateSnapshot().connecting).toBe(false);
  });
});
