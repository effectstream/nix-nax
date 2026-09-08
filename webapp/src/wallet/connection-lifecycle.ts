// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

export class WalletConnectionChangedError extends Error {
  constructor() {
    super("Wallet connection changed while this transaction was pending. Reconnect and try again.");
    this.name = "WalletConnectionChangedError";
  }
}

export class ConnectionGeneration {
  #generation = 0;

  get current(): number {
    return this.#generation;
  }

  begin(): number {
    return ++this.#generation;
  }

  isCurrent(expected: number): boolean {
    return this.#generation === expected;
  }

  assertCurrent(expected: number): void {
    if (!this.isCurrent(expected)) throw new WalletConnectionChangedError();
  }
}

export type TransactionBoundary = () => void;

// Serialize calls that share one wallet/nonce stream. The connection generation
// is captured when the user requests the action, checked again when it reaches
// the head of the queue, and exposed to each proving/balancing/signing/submission
// boundary. A transaction already handed to a wallet/node cannot be retracted.
export class GenerationTransactionQueue {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(
    expected: number,
    current: () => number,
    requireActive: () => void,
    task: (assertCurrent: TransactionBoundary) => Promise<T>,
  ): Promise<T> {
    const assertBoundary = () => {
      if (current() !== expected) throw new WalletConnectionChangedError();
      requireActive();
    };
    const execute = async () => {
      assertBoundary();
      return task(assertBoundary);
    };
    const result = this.#tail.then(execute, execute);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
