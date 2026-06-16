// Bottom-corner turn die. Each turn the contract derives a joint random roll
// (0..15); ODD → place ("Play"), EVEN → remove ("Remove piece").
//   • YOUR die sits bottom-right. On a roll turn it shows "?" and you TAP IT to
//     throw — that sends your intent, which asks the opponent for their random.
//   • The OPPONENT's die sits bottom-left and tumbles on their turn.
// It spins while the ceremony resolves, then lands on the result, with a minimum
// spin so the roll is always visible even when the opponent replies instantly.

import { useEffect, useRef, useState } from "react";

export type DieTarget = "ready" | "rolling" | "play" | "remove" | null;

const MIN_ROLL_MS = 850;

// Pip layout per die value on a 3×3 grid (cells 1..9, left→right, top→bottom).
const PIPS: Record<number, number[]> = {
  1: [5], 2: [3, 7], 3: [3, 5, 7], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9],
};

function Face({ value, className, q }: { value: number; className: string; q?: boolean }) {
  return (
    <div className={`die-face ${className}`}>
      {q
        ? <span className="die-q">?</span>
        : Array.from({ length: 9 }, (_, i) => <span key={i} className={`pip ${PIPS[value].includes(i + 1) ? "on" : ""}`} />)}
    </div>
  );
}

interface Props {
  target: DieTarget;
  side?: "left" | "right";   // bottom-right = you (default), bottom-left = opponent
  caption?: string;          // small label above the die ("You" / "AI" / "Opponent")
  onThrow?: () => void;      // called when you tap a "ready" die to roll
}

export default function TurnDie({ target, side = "right", caption, onThrow }: Props) {
  const [shown, setShown] = useState<DieTarget>(target);
  const shownRef = useRef<DieTarget>(target);
  const rollStart = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const set = (v: DieTarget) => { shownRef.current = v; setShown(v); };

  useEffect(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (target === null) { set(null); return; }
    if (target === "rolling") { rollStart.current = Date.now(); set("rolling"); return; }
    // "ready" / "play" / "remove": if mid-roll, hold the spin for the minimum
    // time before landing; otherwise (ready prompt, or turn 0) show it at once.
    if (shownRef.current !== "rolling") { set(target); return; }
    const wait = Math.max(0, MIN_ROLL_MS - (Date.now() - rollStart.current));
    timer.current = setTimeout(() => set(target), wait);
    return () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  if (shown === null) return null;
  const rolling = shown === "rolling";
  const ready = shown === "ready";
  const result = rolling || ready ? "" : shown; // "play" | "remove"
  const frontValue = shown === "remove" ? 2 : 5; // even→remove, odd→play
  const label = ready ? "Tap to roll" : rolling ? "Rolling…" : shown === "play" ? "Play" : "Remove piece";

  return (
    <div className={`die-stage ${side} ${ready ? "throwable" : ""}`}>
      {caption && <div className="die-caption">{caption}</div>}
      <div className="die-scene" onClick={ready ? onThrow : undefined} role={ready ? "button" : undefined} title={ready ? "Throw the dice" : undefined}>
        <div className={`die ${rolling ? "rolling" : "settled"} ${result} ${ready ? "ready" : ""}`}>
          <Face value={frontValue} className="f-front" q={ready} />
          <Face value={6} className="f-back" />
          <Face value={3} className="f-right" />
          <Face value={4} className="f-left" />
          <Face value={1} className="f-top" />
          <Face value={2} className="f-bottom" />
        </div>
      </div>
      <div className={`die-label ${result}`}>{label}</div>
    </div>
  );
}
