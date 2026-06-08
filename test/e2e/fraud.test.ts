// E2E fraud-proof: X equivocates by revealing two different (turn=2, cell=*)
// tokens. O detects this, builds a proof, calls proveEquivocationByX,
// and wins. Requires the local stack.

import { describe, test, expect } from "vitest";
import { Status, Winner } from "../../src/contract/managed/contract/index.js";
import { openChannelTogether } from "../../src/sdk/game/game-session.ts";

describe("e2e: equivocation fraud proof", () => {
  test("X reveals two turn-2 tokens (cells 4 and 5) -> O wins instantly", async () => {
    const { x, o, contractAddress } = await openChannelTogether();
    x.setOpponent(o);
    o.setOpponent(x);
    console.log("Deployed channel at", contractAddress);

    // X plays cell 0. O plays cell 3. Now turn=2 is X's again.
    const m0 = x.myMove(0);
    expect(o.receiveMove(m0).ok).toBe(true);
    const m1 = o.myMove(3);
    expect(x.receiveMove(m1).ok).toBe(true);

    // X equivocates: produces two SignedMoves for turn=2 at different cells.
    // O ends up holding both (in a real attack X would send one to each side
    // of a "split" — here we just synthesise the pair).
    const moveA = x.forgeMove(2, 4, /* prevHash */ buf(m1), x.moves[1].boardAfter); // X:4
    const moveB = x.forgeMove(2, 5, /* prevHash */ buf(m1), x.moves[1].boardAfter); // X:5

    // O calls proveEquivocationByX. The settle outcome bypasses the challenge
    // window for fraud proofs — winner is set to O immediately.
    const txId = await o.proveEquivocation([moveA, moveB]);
    console.log("proveEquivocationByX txId:", txId);

    const led = await o.readState();
    expect(led.winner).toBe(Winner.o);
    expect(led.status).toBe(Status.settled);
  }, 600_000);
});

import { hashSignedMove } from "../../src/sdk/crypto/signed-move.ts";
function buf(m: import("../../src/sdk/crypto/signed-move.ts").SignedMove) {
  return hashSignedMove(m);
}
