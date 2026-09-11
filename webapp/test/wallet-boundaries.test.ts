// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  ConnectionGeneration,
  GenerationTransactionQueue,
  WalletConnectionChangedError,
} from "../src/wallet/connection-lifecycle.ts";
import { createConnectorWalletProviders } from "../src/wallet/connector-adapter.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("wallet transaction boundaries", () => {
  it("rejects both an already-started stale task and a stale queued task", async () => {
    const lifecycle = new ConnectionGeneration();
    const queue = new GenerationTransactionQueue();
    const release = deferred<void>();
    const secondBody = vi.fn(async () => "second");
    const active = () => {};
    const token = lifecycle.current;

    const first = queue.run(token, () => lifecycle.current, active, async (assertCurrent) => {
      await release.promise;
      assertCurrent();
      return "first";
    });
    const second = queue.run(token, () => lifecycle.current, active, secondBody);
    await Promise.resolve();
    lifecycle.begin();
    release.resolve();

    await expect(first).rejects.toBeInstanceOf(WalletConnectionChangedError);
    await expect(second).rejects.toBeInstanceOf(WalletConnectionChangedError);
    expect(secondBody).not.toHaveBeenCalled();
  });

  it("stops a connector balance result after the wallet changes", async () => {
    const lifecycle = new ConnectionGeneration();
    const token = lifecycle.current;
    const balanced = deferred<{ tx: string }>();
    const api = {
      balanceUnsealedTransaction: vi.fn(() => balanced.promise),
      submitTransaction: vi.fn(),
    };
    const { walletProvider } = createConnectorWalletProviders(
      api as never,
      "coin-key",
      "encryption-key",
      () => lifecycle.assertCurrent(token),
    );
    const pending = walletProvider.balanceTx({ serialize: () => new Uint8Array([1]) } as never);
    lifecycle.begin();
    balanced.resolve({ tx: "00" });

    await expect(pending).rejects.toBeInstanceOf(WalletConnectionChangedError);
  });

  it("marks a completed connector submission uncertain after the wallet changes", async () => {
    const lifecycle = new ConnectionGeneration();
    const token = lifecycle.current;
    const submitted = deferred<void>();
    const api = {
      balanceUnsealedTransaction: vi.fn(),
      submitTransaction: vi.fn(() => submitted.promise),
    };
    const { midnightProvider } = createConnectorWalletProviders(
      api as never,
      "coin-key",
      "encryption-key",
      () => lifecycle.assertCurrent(token),
    );
    const pending = midnightProvider.submitTx({ serialize: () => new Uint8Array([2]) } as never);
    lifecycle.begin();
    submitted.resolve();

    await expect(pending).rejects.toBeInstanceOf(WalletConnectionChangedError);
    expect(api.submitTransaction).toHaveBeenCalledOnce();
  });
});
