import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { pruneSavedGames } from "./game/storage.ts";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);

// Bound stored sessions to the current + one previous game on every load, so
// pre-existing bloat is cleaned even before the first save. (Sessions are large.)
try { pruneSavedGames(); } catch { /* never block boot on storage */ }

if (location.hash.replace("#", "") === "board-dev") {
  // Dev-only Board3D playground (no wallet/relay). See src/dev/board-harness.tsx.
  import("./dev/board-harness.tsx").then(({ default: BoardHarness }) => {
    root.render(<BoardHarness />);
  });
} else if (location.hash.replace("#", "") === "wallet-dev") {
  // De-risk smoke: full WalletFacade syncing in-browser. See src/dev/wallet-smoke.tsx.
  import("./dev/wallet-smoke.tsx").then(({ default: WalletSmoke }) => {
    root.render(<WalletSmoke />);
  });
} else {
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
