// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

// Submit the player's create / join on-chain. Serverless: the tx is built,
// proven, balanced (dust), and submitted entirely in the browser via the
// in-browser gas wallet (see chain/arena.ts + wallet/local-wallet.ts) — no relay.

import { api } from "../chain/arena.ts";
import { logEvent } from "../game/log-store.ts";

export type SubmitResult = { via: "local"; txId?: string };

type CreateArgs = { gameId: string; idX: string; rootX: string };
type JoinArgs = { gameId: string; idO: string; rootO: string };

export async function submitCreateGame(args: CreateArgs): Promise<SubmitResult> {
  const res = await api.createGame(args);
  logEvent("create-game: built + proven + submitted in-browser (you paid the gas)");
  return { via: "local", txId: res.txId };
}

export async function submitJoin(args: JoinArgs): Promise<SubmitResult> {
  const res = await api.join(args);
  logEvent("join: built + proven + submitted in-browser (you paid the gas)");
  return { via: "local", txId: res.txId };
}
