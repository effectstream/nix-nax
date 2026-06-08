// E2E timeout/forfeit: X plays one move, O stops responding. X settles the
// single-move history (turnMark flips to 2), arms a timeout, waits for it to
// elapse, and claims the forfeit. Requires the local stack.

import { describe, test, expect } from "vitest";
import { Status, Winner } from "../../src/contract/managed/contract/index.js";
import { openChannelTogether } from "../../src/sdk/game/game-session.ts";
import { sleep } from "./helpers.ts";

describe("e2e: timeout / forfeit", () => {
  test("O stops responding -> X startTimeout + claimTimeout -> X wins", async () => {
    const { x, o, contractAddress } = await openChannelTogether();
    x.setOpponent(o);
    o.setOpponent(x);
    console.log("Deployed channel at", contractAddress);

    // X plays one move; it's now O's turn but O is silent.
    const m0 = x.myMove(0);
    expect(o.receiveMove(m0).ok).toBe(true);

    // X settles the 1-move history with a 1s challenge window so we can
    // promptly arm the timeout. (The on-chain `turnMark` becomes 2 = O.)
    const settleTxId = await x.settle(1);
    console.log("settle txId:", settleTxId);
    let led = await x.readState();
    expect(led.committedTurns).toBe(1n);
    expect(led.turnMark).toBe(2n);

    // Give the indexer time to catch up to the settle tx so the next
    // built tx sees the post-settle contract state. Substrate block-time
    // is ~6s plus indexer ingestion delay.
    await sleep(20_000);

    // X arms a 5s deadline. (Block-time on Midnight's substrate is in seconds.)
    const graceSec = 10;
    const armTxId = await x.startTimeout(graceSec);
    console.log("startTimeout txId:", armTxId);
    led = await x.readState();
    expect(led.hasDeadline).toBe(true);

    // Wait past the deadline then claim.
    await sleep((graceSec + 4) * 1000);
    const claimTxId = await x.claimTimeout();
    console.log("claimTimeout txId:", claimTxId);

    led = await x.readState();
    expect(led.winner).toBe(Winner.x);
    expect(led.status).toBe(Status.settled);
  }, 600_000);
});
