// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

// Helpers for recognizing Web Storage capacity failures. AI sessions contain
// credentials too, so pruning is available only for explicit user-driven cleanup;
// normal persistence never calls it automatically.

const AI_PREFIX = "ai-o:";

export function isQuotaError(e: unknown): boolean {
  const candidate = e as { name?: unknown; code?: unknown } | null;
  return (
    candidate !== null &&
    typeof candidate === "object" &&
    // name is the modern check; code 22 / the Firefox name cover older engines
    // and storage test doubles that cannot construct a DOMException.
    (candidate.name === "QuotaExceededError" ||
      candidate.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
      candidate.code === 22)
  );
}

// Remove every `ai-o:*` entry except those in `protect`. Call only after the user
// explicitly chooses to delete practice sessions. Returns the count removed.
export function pruneAiSessions(protect: Set<string> = new Set()): number {
  let removed = 0;
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k && k.startsWith(AI_PREFIX) && !protect.has(k)) {
      localStorage.removeItem(k);
      removed++;
    }
  }
  return removed;
}
