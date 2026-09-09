// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

import { useState } from "react";
import Home from "./ui/Home.tsx";
import GameView from "./ui/GameView.tsx";
import WalletButton from "./ui/WalletButton.tsx";
import type { PlayerSession } from "./game/player-session.ts";

export default function App() {
  const [session, setSession] = useState<PlayerSession | null>(null);
  return (
    <>
      {session ? (
        <GameView session={session} onLeave={() => setSession(null)} />
      ) : (
        <Home onOpen={setSession} />
      )}
      {/* Permanent top-right wallet control, on every screen. */}
      <WalletButton />
    </>
  );
}
