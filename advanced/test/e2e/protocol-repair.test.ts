// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

import { describe, expect, test } from "vitest";
import { Status, Winner } from "../../contract/managed/contract/index.js";
import { KIND_PLACE } from "../../../src/sdk/game/rules.ts";
import { verifyRandomReveal, type RandomReveal } from "../../../src/sdk/crypto/signed-move.ts";
import {
  freshPlayers,
  hexOf,
  intentFor,
  responderOf,
  SCHEDULE_C,
  SIXTEEN_C,
} from "../helpers/fixtures.ts";
import { openGame } from "./driver.ts";
import { sleep } from "./helpers.ts";

const P = (cell: number, size: number) => ({ kind: KIND_PLACE as 1, cell, size });
const deadline = (seconds: number) => BigInt(Math.floor(Date.now() / 1000) + seconds);

async function waitUntilAfter(by: bigint) {
  const remaining = Number(by) - Math.floor(Date.now() / 1000) + 2;
  if (remaining > 0) await sleep(remaining * 1000);
}

describe("e2e: repaired advanced protocol", () => {
  test("roll answer, public entropy proof reuse, legal continuation, and optimistic claim", async () => {
    const pair = freshPlayers(SCHEDULE_C);
    const game = await openGame(pair);

    const openingUntil = deadline(120);
    console.log("opening settle2 tx:", await game.settleChunkVariant(
      0,
      [P(0, 0), P(4, 0)],
      2,
      openingUntil,
    ));
    expect((await game.readDyn()).committedTurns).toBe(2);

    console.log("challengeRoll tx:", await game.challengeRoll(1, deadline(90)));
    expect((await game.readDyn()).hasRollChallenge).toBe(true);
    console.log("answerRollChallenge tx:", await game.answerRollChallenge(1));
    expect((await game.readDyn()).hasRollChallenge).toBe(false);

    console.log("requestEntropy tx:", await game.requestEntropy("x", 2, deadline(90)));
    console.log("answerEntropy tx:", await game.answerEntropy(2));
    const response = await game.readEntropyResponse(2);
    expect(response).not.toBeNull();
    const publicReveal: RandomReveal = {
      channelId: hexOf(pair.gameId),
      turn: 2,
      slot: Number(response.slot),
      bits: [response.b0, response.b1, response.b2, response.b3].map(Number),
      random: response.random,
      path: response.path,
    };
    expect(verifyRandomReveal(
      publicReveal,
      hexOf(pair.gameId),
      2,
      intentFor(pair, 2).slot,
      responderOf(pair, 2).random.root.field,
    )).toEqual({ ok: true });

    const winUntil = deadline(120);
    console.log("winning settle tx:", await game.settleChunk(
      2,
      [P(1, 0), P(5, 0), P(2, 0), P(6, 0), P(3, 1)],
      winUntil,
    ));
    let dyn = await game.readDyn();
    expect(dyn.committedTurns).toBe(7);
    expect(dyn.winner).toBe(Winner.x);
    expect(dyn.hasChallenge).toBe(true);

    await waitUntilAfter(winUntil);
    const before = await game.readWinBalance();
    console.log("optimistic claimResult tx:", await game.claimResult("x"));
    dyn = await game.readDyn();
    expect(dyn.status).toBe(Status.settled);
    await sleep(10_000);
    expect(await game.readWinBalance()).toBe(before + 1n);
  }, 900_000);

  test("withheld entropy response forfeits to the current mover and mints its reward", async () => {
    const pair = freshPlayers(SCHEDULE_C);
    const game = await openGame(pair);
    const openingUntil = deadline(45);
    console.log("withholding opening settle2 tx:", await game.settleChunkVariant(
      0,
      [P(0, 0), P(4, 0)],
      2,
      openingUntil,
    ));

    const respondBy = deadline(35);
    console.log("withholding requestEntropy tx:", await game.requestEntropy("x", 2, respondBy));
    await waitUntilAfter(respondBy);
    console.log("claimEntropyTimeout tx:", await game.claimEntropyTimeout());
    let dyn = await game.readDyn();
    expect(dyn.winner).toBe(Winner.x);
    expect(dyn.status).toBe(Status.inProgress);

    await waitUntilAfter(openingUntil);
    const before = await game.readWinBalance();
    console.log("forfeit claimResult tx:", await game.claimResult("x"));
    dyn = await game.readDyn();
    expect(dyn.status).toBe(Status.settled);
    await sleep(10_000);
    expect(await game.readWinBalance()).toBe(before + 1n);
  }, 900_000);

  test("the repaired settle11 circuit fits and lands on node 1.0.0", async () => {
    const pair = freshPlayers(SCHEDULE_C);
    const game = await openGame(pair);
    const started = Date.now();
    const txId = await game.settleChunkVariant(0, SIXTEEN_C.slice(0, 11), 11, deadline(300));
    console.log(`repaired settle11 tx: ${txId} (${((Date.now() - started) / 1000).toFixed(0)}s)`);
    const dyn = await game.readDyn();
    expect(dyn.committedTurns).toBe(11);
    expect(dyn.winner).toBe(Winner.none);
  }, 900_000);
});
