// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

// E2E happy path (simplified arena): one-time arena deploy for the suite, then
// a fast createGame/joinGame, a scripted 7-move X-win (4-in-a-row) settled in
// ONE chunk, and an immediate claimResult (no challenge window in the
// simplified contract). Requires the local stack.

import { describe, test, expect } from "vitest";
import { Status, Winner } from "../../src/contract/managed/contract/index.js";
import { freshPlayers, SCHEDULE_C } from "../helpers/fixtures.ts";
import { openGame } from "./driver.ts";
import { sleep } from "./helpers.ts";
import { KIND_PLACE, KIND_REMOVE } from "../../src/sdk/game/rules.ts";

const P = (cell: number, size: number) => ({ kind: KIND_PLACE as 1, cell, size });
const R = (cell: number) => ({ kind: KIND_REMOVE as 2, cell, size: 0 });

describe("e2e: happy path", () => {
  test("X wins a full row -> settle records winner.x -> claimResult mints", async () => {
    const pair = freshPlayers(SCHEDULE_C);
    const g = await openGame(pair);
    console.log("Game opened on arena", g.contractAddress);

    // X fills row 0 (cells 0,1,2,3) over turns 0,2,4,6; O plays 4,5,6.
    const settleTx = await g.settleChunk(0, [P(0, 0), P(4, 0), P(1, 0), P(5, 0), P(2, 0), P(6, 0), P(3, 1)]);
    console.log("settle txId:", settleTx);

    let d = await g.readDyn();
    expect(d.committedTurns).toBe(7);
    expect(d.winner).toBe(Winner.x);
    expect(d.status).toBe(Status.inProgress);

    const winsBefore = await g.readWinBalance();
    console.log("win-token balance before claim:", winsBefore);

    // No challenge window — the winner redeems immediately.
    const claimTx = await g.claimResult();
    console.log("claimResult txId:", claimTx);

    d = await g.readDyn();
    expect(d.status).toBe(Status.settled);
    expect(d.winner).toBe(Winner.x);

    // claimResult actually minted one shielded win-token to the winner's
    // wallet (the sim can't observe minting — this is the real check).
    await sleep(10_000);
    const winsAfter = await g.readWinBalance();
    console.log("win-token balance after claim:", winsAfter);
    expect(winsAfter).toBe(winsBefore + 1n);
  }, 900_000);

  test("multi-chunk settle with a removal; loser cannot claim", async () => {
    const pair = freshPlayers(SCHEDULE_C);
    const g = await openGame(pair);

    // 11 moves split 8 + 3 — NEVER a 1-move chunk: the node's fee layer rejects
    // minimal-transcript settle txs (Malformed(FeeCalculation), see README
    // "Known issues"), which with this contract means any single-move settle.
    // t6 X places at 8; t7 O removes it, returning the piece to X's reserve.
    const moves = [P(0, 0), P(4, 0), P(1, 0), P(5, 0), P(2, 0), P(6, 0), P(8, 1), R(8)];
    const tx1 = await g.settleChunk(0, moves);
    console.log("settle chunk 1 txId:", tx1);
    let d = await g.readDyn();
    expect(d.committedTurns).toBe(8);
    expect(d.winner).toBe(Winner.none);
    expect(d.turnMark).toBe(1); // X to move next
    expect(await g.readAction(7)).toBe(KIND_REMOVE * 64 + 8);
    expect(await g.readTop(8)).toBe(0);
    expect(await g.readReserve(1, 1)).toBe(3);

    // X re-places the returned piece; after O's reply, X completes row 0.
    const tx2 = await g.settleChunk(8, [P(8, 1), P(9, 1), P(3, 1)]);
    console.log("settle chunk 2 txId:", tx2);
    d = await g.readDyn();
    expect(d.committedTurns).toBe(11);
    expect(d.winner).toBe(Winner.x);

    // The loser (O) cannot finalise a decided game.
    await expect(g.claimResult("o")).rejects.toThrow(/only the winner|SegmentFail|FailFallible/i);

    const claimTx = await g.claimResult("x");
    console.log("claimResult txId:", claimTx);
    d = await g.readDyn();
    expect(d.status).toBe(Status.settled);
  }, 900_000);
});
