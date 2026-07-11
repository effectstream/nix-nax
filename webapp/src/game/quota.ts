// Quota-resilient localStorage writes.
//
// Every serialized session (human `nixnax:session:*` and the AI's `ai-o:*`) carries
// the full Merkle-tree secrets — `tokenSecrets` alone is 8320×32 bytes — so each
// entry is >1 MB in UTF-16 storage. A handful of practice games therefore blows
// past the browser's ~5 MB localStorage quota. When that happens we free space
// by evicting *stale practice-AI blobs* (`ai-o:*`), which are pure throwaway
// state, and retry. The caller protects the game(s) that must survive.

const AI_PREFIX = "ai-o:";

export function isQuotaError(e: unknown): boolean {
  return (
    e instanceof DOMException &&
    // name is the modern check; code 22 / the Firefox name cover older engines.
    (e.name === "QuotaExceededError" ||
      e.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
      e.code === 22)
  );
}

// Remove every `ai-o:*` entry except those in `protect`. Returns the count removed.
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
