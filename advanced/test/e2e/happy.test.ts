// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

// E2E happy path (arena): one-time arena deploy for the suite, then a fast
// createGame/joinGame, a scripted 7-move X-win (4-in-a-row) settled in ONE
// chunk, and claimResult after the challenge window. Requires the local stack.

import { describe, test, expect } from "vitest";
import { Status, Winner } from "../../contract/managed/contract/index.js";
import { freshPlayers, SCHEDULE_C } from "../helpers/fixtures.ts";
import { openGame } from "./driver.ts";
import { sleep } from "./helpers.ts";
import { KIND_PLACE } from "../../../src/sdk/game/rules.ts";

const P = (cell: number, size: number) => ({ kind: KIND_PLACE as 1, cell, size });

describe("e2e: happy path", () => {
  test("X wins a full row -> chunked settle records winner.x -> claimResult", async () => {
    const pair = freshPlayers(SCHEDULE_C);
    const g = await openGame(pair);
    console.log("Game opened on arena", g.contractAddress);

    // The window must comfortably exceed settle's proof-build latency: the floor
    // (minWindowSecs) is asserted at settle EXECUTION time, and untilTime is an
    // absolute timestamp fixed before the (~minute-long, k=17) build. 150s gives
    // ample margin over both the 5s e2e floor and the build.
    const challengeWindowSec = 150;
    const untilTime = BigInt(Math.floor(Date.now() / 1000) + challengeWindowSec);
    // X fills row 0 (cells 0,1,2,3) over turns 0,2,4,6; O plays 4,5,6.
    const settleTx = await g.settleChunk(0, [P(0, 0), P(4, 0), P(1, 0), P(5, 0), P(2, 0), P(6, 0), P(3, 1)], untilTime);
    console.log("settle txId:", settleTx);

    let d = await g.readDyn();
    expect(d.committedTurns).toBe(7);
    expect(d.winner).toBe(Winner.x);
    expect(d.hasChallenge).toBe(true);
    expect(d.status).toBe(Status.inProgress);

    const winsBefore = await g.readWinBalance();
    console.log("win-token balance before claim:", winsBefore);

    await sleep(160_000); // wait out the full 150s challenge window
    const claimTx = await g.claimResult();
    console.log("claimResult txId:", claimTx);

    d = await g.readDyn();
    expect(d.status).toBe(Status.settled);
    expect(d.winner).toBe(Winner.x);

    // M1 end-to-end: claimResult actually minted one shielded win-token to the
    // winner's wallet (the sim can't observe minting — this is the real check).
    await sleep(10_000);
    const winsAfter = await g.readWinBalance();
    console.log("win-token balance after claim:", winsAfter);
    expect(winsAfter).toBe(winsBefore + 1n);
  }, 900_000);
});
