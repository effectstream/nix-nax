// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

// E2E for the settle variants against a REAL node: proves the settle11 and
// settle2 circuits end-to-end — proof generation, on-chain verification, and
// that the calls fit the node's per-tx budget. Historical pre-repair evidence
// found settle11 at k=17, settle12 at k=18, and settle16 rejected by node 1.0.0.
// Current generated metadata and this repaired-source run are authoritative.
//
// Game 1: a 16-move history in TWO txs (settle11 + settle with a padded
//         5-move tail — O wins on the final move, exercising mixed variants
//         and the in-chunk win on-chain).
// Game 2: a 2-move opening committed via settle2 (the fast-tail variant).

import { describe, test, expect } from "vitest";
import { Winner } from "../../contract/managed/contract/index.js";
import { freshPlayers, SCHEDULE_C, SIXTEEN_C } from "../helpers/fixtures.ts";
import { openGame } from "./driver.ts";

describe("e2e: settle variants", () => {
  test("settle11 + settle: 16 moves land in two txs; win on the final move", async () => {
    const pair = freshPlayers(SCHEDULE_C);
    const g = await openGame(pair);
    console.log("settle11 game on arena", g.contractAddress);

    let untilTime = BigInt(Math.floor(Date.now() / 1000) + 600);
    let t0 = Date.now();
    const tx1 = await g.settleChunkVariant(0, SIXTEEN_C.slice(0, 11), 11, untilTime);
    console.log(`settle11 txId: ${tx1} (proved+landed in ${((Date.now() - t0) / 1000).toFixed(0)}s)`);

    let d = await g.readDyn();
    expect(d.committedTurns).toBe(11);
    expect(d.winner).toBe(Winner.none);

    untilTime = BigInt(Math.floor(Date.now() / 1000) + 600);
    t0 = Date.now();
    const tx2 = await g.settleChunkVariant(11, SIXTEEN_C.slice(11), 8, untilTime);
    console.log(`settle(8, 5-move tail) txId: ${tx2} (proved+landed in ${((Date.now() - t0) / 1000).toFixed(0)}s)`);

    d = await g.readDyn();
    expect(d.committedTurns).toBe(16);
    expect(d.winner).toBe(Winner.o);
    expect(d.hasChallenge).toBe(true);
  }, 900_000);

  test("settle2: a 2-move chunk lands via the small fast circuit", async () => {
    const pair = freshPlayers(SCHEDULE_C);
    const g = await openGame(pair);
    console.log("settle2 game on arena", g.contractAddress);

    const untilTime = BigInt(Math.floor(Date.now() / 1000) + 300);
    const t0 = Date.now();
    const tx = await g.settleChunkVariant(0, SIXTEEN_C.slice(0, 2), 2, untilTime);
    console.log(`settle2 txId: ${tx} (proved+landed in ${((Date.now() - t0) / 1000).toFixed(0)}s)`);

    const d = await g.readDyn();
    expect(d.committedTurns).toBe(2);
    expect(d.winner).toBe(Winner.none);
  }, 900_000);
});
