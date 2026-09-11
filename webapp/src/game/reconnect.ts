// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

export function canReconnectSavedGame(relayAvailable: boolean | null, practiceVsAi: boolean): boolean {
  return practiceVsAi || relayAvailable !== false;
}
