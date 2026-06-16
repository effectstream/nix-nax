// Flavour copy for the AI's turn. The local AI computes its move off-chain, so
// its turn can take a beat — a static "Waiting…" reads as frozen / buggy. While
// it thinks we cycle through these instead, so it clearly looks like it's working.
// A couple are true to the protocol (the parity roll, the signed-move commit).

const AI_THOUGHTS = [
  "Analyzing the match…",
  "Calculating the best move…",
  "Evaluating positions…",
  "Searching the game tree…",
  "Weighing its options…",
  "Plotting its next move…",
  "Sizing up the board…",
  "Looking for a winning line…",
  "Considering a counter-move…",
  "Thinking a few moves ahead…",
  "Rolling for its turn…",
  "Committing to its move…",
] as const;

// Pick a thought different from `prev` so the rotation never repeats in place.
export function nextAiThought(prev?: string): string {
  if (AI_THOUGHTS.length <= 1) return AI_THOUGHTS[0];
  let m: string | undefined = prev;
  while (m === prev || m === undefined) {
    m = AI_THOUGHTS[Math.floor(Math.random() * AI_THOUGHTS.length)];
  }
  return m;
}
