// E2E happy path: deploy, play a 5-move X-win game off-chain, settle, claimResult.
// Requires the local stack (bun run stack:up).

import { describe, test, expect } from "vitest";
import { Status, Winner } from "../../src/contract/managed/contract/index.js";
import { openChannelTogether } from "../../src/sdk/game/game-session.ts";
import { sleep } from "./helpers.ts";

describe("e2e: happy path", () => {
  test("X wins top row -> settle records winner.x", async () => {
    const { x, o, contractAddress } = await openChannelTogether();
    x.setOpponent(o);
    o.setOpponent(x);
    console.log("Deployed channel at", contractAddress);

    // X:0, O:3, X:1, O:4, X:2  — X completes top row.
    const sequence: [string, number][] = [
      ["x", 0], ["o", 3], ["x", 1], ["o", 4], ["x", 2],
    ];
    for (const [who, cell] of sequence) {
      const mover = who === "x" ? x : o;
      const receiver = who === "x" ? o : x;
      const move = mover.myMove(cell);
      const verdict = receiver.receiveMove(move);
      expect(verdict.ok).toBe(true);
    }
    expect(x.moves.length).toBe(5);
    expect(o.moves.length).toBe(5);

    // X submits settle, with a short challenge window (5s).
    const challengeWindowSec = 4;
    const settleTxId = await x.settle(challengeWindowSec);
    console.log("settle txId:", settleTxId);

    let led = await x.readState();
    expect(led.committedTurns).toBe(5n);
    expect(led.winner).toBe(Winner.x);
    expect(led.hasChallenge).toBe(true);
    expect(led.status).toBe(Status.inProgress);

    // Wait past challenge window, then claimResult.
    await sleep((challengeWindowSec + 2) * 1000);
    const claimTxId = await x.claimResult();
    console.log("claimResult txId:", claimTxId);

    led = await x.readState();
    expect(led.status).toBe(Status.settled);
    expect(led.winner).toBe(Winner.x);
  }, 600_000);
});
