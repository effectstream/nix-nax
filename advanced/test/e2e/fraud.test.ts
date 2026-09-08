// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

// E2E fraud (arena): X reveals TWO action tokens for the same turn — O
// slashes with proveEquivocationByX and wins instantly.

import { describe, test, expect } from "vitest";
import { Status, Winner } from "../../contract/managed/contract/index.js";
import { freshPlayers, SCHEDULE_B } from "../helpers/fixtures.ts";
import { openGame } from "./driver.ts";
import { sleep } from "./helpers.ts";
import { KIND_PLACE } from "../../../src/sdk/game/rules.ts";

describe("e2e: equivocation fraud proof", () => {
  test("two X tokens for turn 0 -> proveEquivocationByX -> O wins", async () => {
    const pair = freshPlayers(SCHEDULE_B);
    const g = await openGame(pair);
    console.log("Game opened on arena", g.contractAddress);

    const txId = await g.proveEquivocationByX(
      0,
      { kind: KIND_PLACE, cell: 0, size: 0 },
      { kind: KIND_PLACE, cell: 5, size: 0 },
    );
    console.log("proveEquivocationByX txId:", txId);

    // M1: a fraud proof decides the game but leaves it inProgress so the winner
    // can still finalise + mint. No challenge window applies to a proven result.
    let d = await g.readDyn();
    expect(d.winner).toBe(Winner.o);
    expect(d.status).toBe(Status.inProgress);

    const winsBefore = await g.readWinBalance();
    const claimTx = await g.claimResult("o"); // O is the winner here
    console.log("claimResult(o) txId:", claimTx);

    d = await g.readDyn();
    expect(d.status).toBe(Status.settled);
    expect(d.winner).toBe(Winner.o);

    await sleep(10_000);
    const winsAfter = await g.readWinBalance();
    expect(winsAfter).toBe(winsBefore + 1n); // fraud-path winner minted (M1)
  }, 900_000);
});
