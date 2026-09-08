// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

// Dev-only Board3D playground — reachable at http://localhost:5173/#board-dev
// (no wallet, relay, or contract). It mocks the game state so the 3D surface
// can be exercised in isolation: toggle which side you are (camera flips to
// that player), switch place/remove mode, and click cells to actually mutate
// the mocked board so placement/removal animations and reserve counts fire.
// Handy for tuning layout/interaction without spinning up a live game.

import { useEffect, useMemo, useState } from "react";
import Board3D, { type BoardMode } from "../ui/Board3D.tsx";
import {
  emptyBoard,
  canPlace,
  canRemove,
  applyAction,
  KIND_PLACE,
  KIND_REMOVE,
  type Mark,
  type Action,
} from "../../../src/sdk/game/rules.ts";

const fullReserves = () => new Uint8Array([3, 3, 3, 3, 3, 3, 3, 3]);

// A few starting pieces so remove mode has opponent targets and stacks show.
function seededBoard(): Uint8Array {
  const b = emptyBoard();
  b[5 * 4 + 0] = 2;  // O size-0 @ c5
  b[6 * 4 + 1] = 1;  // X size-1 @ c6
  b[9 * 4 + 3] = 2;  // O size-3 @ c9
  b[10 * 4 + 0] = 1; // X size-0 @ c10
  return b;
}

export default function BoardHarness() {
  const [board, setBoard] = useState<Uint8Array>(seededBoard);
  const [reserves, setReserves] = useState<Uint8Array>(fullReserves);
  const [myMark, setMyMark] = useState<Mark>(1);
  const [mode, setMode] = useState<BoardMode>("place");
  const [selectedSize, setSelectedSize] = useState(0);
  // Remount Board3D when the side flips so the camera re-initialises to it.
  const [boardKey, setBoardKey] = useState(0);

  const actionableCells = useMemo(() => {
    const set = new Set<number>();
    if (mode === "place") {
      for (let c = 0; c < 16; c++) if (canPlace(board, reserves, myMark, selectedSize, c)) set.add(c);
    } else if (mode === "remove") {
      for (let c = 0; c < 16; c++) if (canRemove(board, myMark, c)) set.add(c);
    }
    return set;
  }, [board, reserves, myMark, mode, selectedSize]);

  // Expose state so the dev/automation can assert without reading pixels.
  useEffect(() => {
    (window as unknown as { __h?: unknown }).__h = {
      reserves: Array.from(reserves),
      board: Array.from(board),
      myMark, mode, selectedSize,
      actionable: Array.from(actionableCells).sort((a, b) => a - b),
    };
  });

  const onCellClick = (cell: number) => {
    const action: Action =
      mode === "place"
        ? { kind: KIND_PLACE, cell, size: selectedSize }
        : { kind: KIND_REMOVE, cell, size: 0 };
    const r = applyAction(board, reserves, myMark, action);
    setBoard(r.board);
    setReserves(r.reserves);
  };

  const reset = () => {
    setBoard(seededBoard());
    setReserves(fullReserves());
    setSelectedSize(0);
  };

  const flipSide = () => {
    setMyMark((m) => (m === 1 ? 2 : 1));
    setBoardKey((k) => k + 1);
  };

  const btn = (on: boolean): React.CSSProperties => ({
    padding: "6px 12px",
    borderRadius: 8,
    border: "1px solid #2a3a55",
    background: on ? "#16e0c8" : "#0d1626",
    color: on ? "#06121f" : "#cfe0ff",
    cursor: "pointer",
    fontWeight: 600,
  });

  return (
    <div style={{ padding: 18, fontFamily: "ui-sans-serif, system-ui", color: "#cfe0ff" }}>
      <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
        <strong style={{ color: "#16e0c8" }}>Board3D harness</strong>
        <span>
          side:&nbsp;
          <button style={btn(true)} onClick={flipSide}>{myMark === 1 ? "X (near)" : "O (far)"} — flip</button>
        </span>
        <span style={{ display: "inline-flex", gap: 6 }}>
          mode:
          {(["place", "remove", "view"] as BoardMode[]).map((m) => (
            <button key={m} style={btn(mode === m)} onClick={() => setMode(m)}>{m}</button>
          ))}
        </span>
        <span style={{ display: "inline-flex", gap: 6 }}>
          size:
          {[0, 1, 2, 3].map((s) => (
            <button key={s} style={btn(selectedSize === s)} onClick={() => setSelectedSize(s)}>
              {["XS", "S", "M", "L"][s]}
            </button>
          ))}
        </span>
        <button style={btn(false)} onClick={reset}>reset</button>
        <span style={{ opacity: 0.7, fontSize: 13 }}>
          place mode: a piece rides the cursor — green over a legal cell, red otherwise. Click a reserve
          lane to grab that size · Esc / right-click drops it · click a glowing cell to place.
        </span>
      </div>
      <div style={{ maxWidth: 1100, height: "74vh" }}>
        <Board3D
          key={boardKey}
          board={board}
          reserves={reserves}
          myMark={myMark}
          mode={mode}
          actionableCells={actionableCells}
          selectedSize={selectedSize}
          onSelectSize={setSelectedSize}
          onCellClick={onCellClick}
          active={mode !== "view"}
        />
      </div>
    </div>
  );
}
