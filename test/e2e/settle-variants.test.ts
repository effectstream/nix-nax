// E2E for the settle variants against a REAL node: proves the settle16 and
// settle2 circuits end-to-end — proof generation (k≈18 for settle16, the
// largest circuit in the contract), on-chain verification, and, critically,
// that a settle16 CALL fits the node's per-block weight budget (a 16-slot
// settle exhausted it on the pre-1.0 node; this is the empirical re-check).
//
// Game 1: a full 16-move history committed in ONE settle16 tx (O wins on the
//         final move — also exercises the in-chunk win path at size 16).
// Game 2: a 2-move opening committed via settle2 (the fast-tail variant).

import { describe, test, expect } from "vitest";
import { Winner } from "../../src/contract/managed/contract/index.js";
import { freshPlayers, SCHEDULE_C, SIXTEEN_C } from "../helpers/fixtures.ts";
import { openGame } from "./driver.ts";

describe("e2e: settle variants", () => {
  test("settle16: 16 moves land in ONE tx; win on the final move", async () => {
    const pair = freshPlayers(SCHEDULE_C);
    const g = await openGame(pair);
    console.log("settle16 game on arena", g.contractAddress);

    const untilTime = BigInt(Math.floor(Date.now() / 1000) + 300);
    const t0 = Date.now();
    const tx = await g.settleChunkVariant(0, SIXTEEN_C, 16, untilTime);
    console.log(`settle16 txId: ${tx} (proved+landed in ${((Date.now() - t0) / 1000).toFixed(0)}s)`);

    const d = await g.readDyn();
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
