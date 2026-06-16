// E2E timeout/forfeit (arena): X settles one move, O goes silent, X arms a
// timeout and claims the forfeit after the deadline.

import { describe, test, expect } from "vitest";
import { Status, Winner } from "../../src/contract/managed/contract/index.js";
import { buildPlayers, SCHEDULE_A } from "../helpers/fixtures.ts";
import { openGame } from "./driver.ts";
import { sleep } from "./helpers.ts";
import { KIND_PLACE } from "../../src/sdk/game/rules.ts";

describe("e2e: timeout / forfeit", () => {
  test("O stops responding -> X startTimeout + claimTimeout -> X wins", async () => {
    const pair = buildPlayers(SCHEDULE_A, "e2e-timeout", 0xab99cdn);  // unique gameId (≠ playersC)
    const g = await openGame(pair);
    console.log("Game opened on arena", g.contractAddress);

    const untilTime = BigInt(Math.floor(Date.now() / 1000) + 600);
    const settleTx = await g.settleChunk(0, [{ kind: KIND_PLACE, cell: 0, size: 0 }], untilTime);
    console.log("settle txId:", settleTx);
    let d = await g.readDyn();
    expect(d.committedTurns).toBe(1);
    expect(d.turnMark).toBe(2);

    await sleep(20_000);

    const graceSec = 10;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + graceSec);
    const armTx = await g.startTimeoutAsX(deadline);
    console.log("startTimeout txId:", armTx);
    d = await g.readDyn();
    expect(d.hasDeadline).toBe(true);

    await sleep((graceSec + 10) * 1000);
    const claimTx = await g.claimTimeout();
    console.log("claimTimeout txId:", claimTx);

    d = await g.readDyn();
    expect(d.winner).toBe(Winner.x);
    expect(d.status).toBe(Status.settled);
  }, 600_000);
});
