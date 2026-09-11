// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

import { useEffect, useState } from "react";
import { nextAiThought } from "../../game/ai-flavor.ts";
import { startAiOpponent } from "../../game/ai-opponent.ts";

export function useAiOpponent(gameId: string, vsAi: boolean) {
  // Local AI opponent (Practice vs AI) runs O headless in this same tab.
  useEffect(() => {
    if (!vsAi) return;
    const ai = startAiOpponent(gameId);
    return () => ai.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId, vsAi]);
}

export function useAiThinking(aiThinking: boolean): string {
  const [aiMsg, setAiMsg] = useState<string>(() => nextAiThought());

  useEffect(() => {
    if (!aiThinking) return;
    setAiMsg((m) => nextAiThought(m));
    const id = setInterval(() => setAiMsg((m) => nextAiThought(m)), 2200);
    return () => clearInterval(id);
  }, [aiThinking]);

  return aiMsg;
}
