// 3×3 board grid.

export interface BoardProps {
  board: Uint8Array;            // length 9; 0 empty, 1 X, 2 O
  onCellClick?: (cell: number) => void;
  disabled?: boolean;
  highlightCells?: number[];    // for fraud indicator etc.
}

export default function Board({ board, onCellClick, disabled, highlightCells }: BoardProps) {
  return (
    <div className="board">
      {Array.from({ length: 9 }, (_, i) => {
        const v = board[i];
        const filled = v !== 0;
        const cls = ["cell"];
        if (filled) cls.push("filled");
        if (v === 1) cls.push("x");
        if (v === 2) cls.push("o");
        if (disabled || filled) cls.push("disabled");
        if (highlightCells?.includes(i)) cls.push("highlight");
        return (
          <div
            key={i}
            className={cls.join(" ")}
            onClick={() => !disabled && !filled && onCellClick?.(i)}
            role="button"
            aria-label={`cell ${i}`}
          >
            {v === 1 ? "X" : v === 2 ? "O" : ""}
          </div>
        );
      })}
    </div>
  );
}
