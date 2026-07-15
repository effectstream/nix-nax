// Pending-redeem registry (localStorage). When you WIN a game and the result
// is settled on-chain, the win-token can only be minted (Redeem/claimResult)
// after the challenge window closes — often many minutes later, by which time
// the tab may be long gone. GameView records the pending redeem here from
// observed chain state; the lobby shows a persistent reminder with a live
// countdown and a Resume button; a successful claim (status → settled)
// removes it.

export interface PendingRedeem {
  gameId: string;
  role: "x" | "o";
  // Absolute UNIX seconds when the challenge window closes and Redeem becomes
  // available. 0 = no window (fraud/timeout wins) — redeemable immediately.
  redeemableAt: number;
  recordedAt: number;
}

const KEY = "nixnax:pending-redeems";

function load(): Record<string, PendingRedeem> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, PendingRedeem>;
  } catch {
    return {};
  }
}

function save(all: Record<string, PendingRedeem>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // storage full — the reminder is a convenience, never break the game for it
  }
}

export function upsertPendingRedeem(p: Omit<PendingRedeem, "recordedAt">): void {
  const all = load();
  const prev = all[p.gameId];
  // Keep the newest window end (settle chunks extend it).
  if (prev && prev.redeemableAt === p.redeemableAt && prev.role === p.role) return;
  all[p.gameId] = { ...p, recordedAt: prev?.recordedAt ?? Date.now() };
  save(all);
}

export function removePendingRedeem(gameId: string): void {
  const all = load();
  if (!(gameId in all)) return;
  delete all[gameId];
  save(all);
}

export function listPendingRedeems(): PendingRedeem[] {
  return Object.values(load()).sort((a, b) => a.redeemableAt - b.redeemableAt);
}

// "04:32" (or "1:02:07" with hours) until `redeemableAt`; null once passed.
export function redeemCountdown(redeemableAt: number, nowMs: number = Date.now()): string | null {
  const s = redeemableAt - Math.floor(nowMs / 1000);
  if (s <= 0) return null;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = String(m).padStart(2, "0"), ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
