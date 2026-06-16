// E2E fraud (arena): X reveals TWO action tokens for the same turn — O
// slashes with proveEquivocationByX and wins instantly.

import { describe, test, expect } from "vitest";
import { Status, Winner } from "../../src/contract/managed/contract/index.js";
import { playersB } from "../helpers/fixtures.ts";
import { openGame } from "./driver.ts";
import { KIND_PLACE } from "../../src/sdk/game/rules.ts";

describe("e2e: equivocation fraud proof", () => {
  test("two X tokens for turn 0 -> proveEquivocationByX -> O wins", async () => {
    const pair = playersB();
    const g = await openGame(pair);
    console.log("Game opened on arena", g.contractAddress);

    const txId = await g.proveEquivocationByX(
      0,
      { kind: KIND_PLACE, cell: 0, size: 0 },
      { kind: KIND_PLACE, cell: 5, size: 0 },
    );
    console.log("proveEquivocationByX txId:", txId);

    const d = await g.readDyn();
    expect(d.winner).toBe(Winner.o);
    expect(d.status).toBe(Status.settled);
  }, 600_000);
});
