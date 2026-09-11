// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  arenaAttachment,
  invalidateArenaAttachment,
  invalidateArenaAttachmentSoon,
} from "../src/chain/attachment-cache.ts";
import type { ArenaAttachment } from "../src/chain/types.ts";

// The cache treats the attachment as opaque. This inert typed fixture exercises
// only identity/lifecycle and never invokes the SDK-backed contract handle.
const attachment = (addr: string) => ({ addr }) as unknown as ArenaAttachment;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

beforeEach(() => invalidateArenaAttachment());

describe("arena attachment cache boundary", () => {
  it("deduplicates creation for one wallet generation", async () => {
    const create = vi.fn(async () => attachment("one"));

    const first = arenaAttachment(3, create);
    const second = arenaAttachment(3, create);

    expect(second).toBe(first);
    await expect(first).resolves.toEqual({ addr: "one" });
    expect(create).toHaveBeenCalledOnce();
  });

  it("replaces a prior generation and an old rejection cannot clear the replacement", async () => {
    const old = deferred<ArenaAttachment>();
    const oldResult = arenaAttachment(4, () => old.promise);
    const current = Promise.resolve(attachment("current"));
    expect(arenaAttachment(5, () => current)).toBe(current);

    const oldFailure = expect(oldResult).rejects.toThrow("old failed");
    old.reject(new Error("old failed"));
    await oldFailure;

    const unexpected = vi.fn(async () => attachment("unexpected"));
    expect(arenaAttachment(5, unexpected)).toBe(current);
    expect(unexpected).not.toHaveBeenCalled();
  });

  it("evicts a rejected current entry", async () => {
    const failed = arenaAttachment(6, async () => { throw new Error("attach failed"); });
    await expect(failed).rejects.toThrow("attach failed");

    const replacement = vi.fn(async () => attachment("replacement"));
    await expect(arenaAttachment(6, replacement)).resolves.toEqual({ addr: "replacement" });
    expect(replacement).toHaveBeenCalledOnce();
  });

  it("keeps synchronous and deferred invalidation timing distinct", async () => {
    const initial = Promise.resolve(attachment("initial"));
    expect(arenaAttachment(7, () => initial)).toBe(initial);

    invalidateArenaAttachmentSoon();
    expect(arenaAttachment(7, () => Promise.resolve(attachment("too soon")))).toBe(initial);
    await Promise.resolve();

    const afterDeferred = Promise.resolve(attachment("after deferred"));
    expect(arenaAttachment(7, () => afterDeferred)).toBe(afterDeferred);

    invalidateArenaAttachment();
    const afterSync = Promise.resolve(attachment("after sync"));
    expect(arenaAttachment(7, () => afterSync)).toBe(afterSync);
  });
});
