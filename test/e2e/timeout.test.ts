// E2E timeout/forfeit (arena): X settles one move, O goes silent, X arms a
// timeout and claims the forfeit after the deadline.

import { describe, test, expect } from "vitest";
import { Status, Winner } from "../../src/contract/managed/contract/index.js";
import { freshPlayers, SCHEDULE_A } from "../helpers/fixtures.ts";
import { openGame } from "./driver.ts";
import { sleep } from "./helpers.ts";
import { KIND_PLACE } from "../../src/sdk/game/rules.ts";

describe("e2e: timeout / forfeit", () => {
  test("O stops responding -> X startTimeout + claimTimeout -> X wins", async () => {
    const pair = freshPlayers(SCHEDULE_A); // random gameId — arena persists across runs
    const g = await openGame(pair);
    console.log("Game opened on arena", g.contractAddress);

    const untilTime = BigInt(Math.floor(Date.now() / 1000) + 150);
    // 5 placements (turns 0..4 are place-class on SCHEDULE_A); turn 5's mover is
    // O, so O is the staller and X arms the timeout.
    //
    // WALLET/NODE QUIRK (not a contract issue): a game's OPENING settle that
    // carries a single move — the smallest possible settle tx — is rejected by
    // the local dev node with Malformed(MalformedError::FeeCalculation): the
    // wallet-side fee estimate and the node's cost model disagree for that tx
    // shape. Verified NOT contract-related and NOT Merkle/trie-depth-related:
    // the same 1-move settle passes in the circuit simulator, passes on-chain
    // once the game has prior committed state (1 move at turn 4 on a deeper
    // trie: OK), and multi-move settles (a superset of the same trie inserts)
    // always pass. Hence this test opens with a multi-move chunk. Drop this
    // once the upstream wallet/node fee fix lands.
    const P5 = [
      { kind: KIND_PLACE as 1, cell: 0, size: 0 },
      { kind: KIND_PLACE as 1, cell: 4, size: 0 },
      { kind: KIND_PLACE as 1, cell: 1, size: 0 },
      { kind: KIND_PLACE as 1, cell: 5, size: 0 },
      { kind: KIND_PLACE as 1, cell: 2, size: 0 },
    ];
    const settleTx = await g.settleChunk(0, P5, untilTime);
    console.log("settle txId:", settleTx);
    let d = await g.readDyn();
    expect(d.committedTurns).toBe(5);
    expect(d.turnMark).toBe(2);

    await sleep(20_000);

    // Grace must exceed startTimeout's own proof-build latency plus the floor
    // (the deadline is asserted > blockTime + minWindowSecs at execution time).
    const graceSec = 90;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + graceSec);
    const armTx = await g.startTimeoutAsX(deadline);
    console.log("startTimeout txId:", armTx);
    d = await g.readDyn();
    expect(d.hasDeadline).toBe(true);

    await sleep((graceSec + 10) * 1000);
    const claimTx = await g.claimTimeout();
    console.log("claimTimeout txId:", claimTx);

    // M1: the forfeit decides the game (winner=x) but leaves it inProgress so
    // the winner can finalise + mint, like every other decided path.
    d = await g.readDyn();
    expect(d.winner).toBe(Winner.x);
    expect(d.status).toBe(Status.inProgress);

    const winsBefore = await g.readWinBalance();
    const claimTx2 = await g.claimResult("x");
    console.log("claimResult txId:", claimTx2);

    d = await g.readDyn();
    expect(d.status).toBe(Status.settled);
    expect(d.winner).toBe(Winner.x);

    await sleep(10_000);
    const winsAfter = await g.readWinBalance();
    expect(winsAfter).toBe(winsBefore + 1n); // timeout-path winner minted (M1)
  }, 900_000);
});
