// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

// Small lifecycle boundary for the wallet-scoped arena attachment. It imports
// neither wallet state nor the arena, so both can invalidate/use the cache
// without forming a runtime cycle.

import type { ArenaAttachment } from "./types.ts";

interface AttachmentEntry {
  generation: number;
  promise: Promise<ArenaAttachment>;
}

let entry: AttachmentEntry | null = null;

export function arenaAttachment(generation: number, create: () => Promise<ArenaAttachment>): Promise<ArenaAttachment> {
  if (entry?.generation === generation) return entry.promise;
  const promise = create();
  promise.catch(() => {
    if (entry?.promise === promise) entry = null;
  });
  entry = { generation, promise };
  return promise;
}

export function invalidateArenaAttachment(): void {
  entry = null;
}

// Wallet selection historically invalidated through a dynamic import. Preserve
// its asynchronous timing now that the cache is a cycle-free leaf.
export function invalidateArenaAttachmentSoon(): void {
  void Promise.resolve().then(invalidateArenaAttachment);
}
