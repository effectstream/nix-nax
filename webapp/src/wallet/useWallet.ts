// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

// Thin React adapter over the React-free wallet state/service.

import { useSyncExternalStore } from "react";
import { subscribeWallet, walletStateSnapshot, type WalletState } from "./state.ts";

export function useWallet(): WalletState {
  return useSyncExternalStore(subscribeWallet, walletStateSnapshot);
}
