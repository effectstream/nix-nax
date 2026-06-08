import { useState } from "react";
import Home from "./ui/Home.tsx";
import GameView from "./ui/GameView.tsx";
import type { PlayerSession } from "./game/player-session.ts";

export default function App() {
  const [session, setSession] = useState<PlayerSession | null>(null);
  return session ? (
    <GameView session={session} onLeave={() => setSession(null)} />
  ) : (
    <Home onOpen={setSession} />
  );
}
