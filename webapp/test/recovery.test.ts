// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { buildPlayers, hexOf, SCHEDULE_A, type TestPlayer } from "../../test/helpers/fixtures.ts";
import { KIND_PLACE } from "../../src/sdk/game/rules.ts";
import type { WireOutbound } from "../src/api/ws.ts";
import { replayRecoverableMessages } from "../src/game/recovery.ts";
import { canReconnectSavedGame } from "../src/game/reconnect.ts";
import {
  decodeIntent,
  decodeMove,
  decodeRandomReveal,
  PlayerSession,
  type PlayerKeys,
  type Role,
  type SerializedSession,
} from "../src/game/player-session.ts";

function playerKeys(role: Role, player: TestPlayer): PlayerKeys {
  return {
    role,
    secret: player.secret,
    id: player.id,
    tokenTree: player.token,
    indexTree: player.index,
    randomTree: player.random,
  };
}

describe("bounded relay recovery", () => {
  it("restores two real sessions, converges lost messages, and rejects a conflicting replay", () => {
    const pair = buildPlayers(SCHEDULE_A, "webapp-recovery", 0xaaa123n);
    const gameId = hexOf(pair.gameId);
    let x = new PlayerSession(
      "x",
      gameId,
      playerKeys("x", pair.x),
      { id: pair.o.id, rootToken: pair.o.token.root.field },
    );
    let o = new PlayerSession(
      "o",
      gameId,
      playerKeys("o", pair.o),
      { id: pair.x.id, rootToken: pair.x.token.root.field },
    );

    // X saved turn 0, but the relay lost the send. Restoring the saved X
    // session must be enough to replay the move into the lagging O session.
    x.myMove({ kind: KIND_PLACE, cell: 0, size: 0 });
    const savedX = x.serialise();
    x = PlayerSession.restore(savedX);
    const persistenceOrder: string[] = [];
    const moveResults: ReturnType<PlayerSession["receiveMove"]>[] = [];

    expect(replayRecoverableMessages(
      x,
      (message) => {
        persistenceOrder.push("send");
        if (message.type === "move") moveResults.push(o.receiveMove(decodeMove(message.payload)));
      },
      () => persistenceOrder.push("persist"),
    )).toEqual(["move 0"]);
    expect(persistenceOrder).toEqual(["persist", "send"]);
    expect(moveResults).toEqual([{ ok: true, status: "playing" }]);
    expect(o.committedTurns).toBe(1);
    expect(o.boardState).toEqual(x.boardState);
    expect(o.reserveState).toEqual(x.reserveState);

    // The same relay history can be delivered again without advancing O.
    const beforeDuplicate = o.serialise();
    expect(replayRecoverableMessages(
      x,
      (message) => {
        if (message.type === "move") moveResults.push(o.receiveMove(decodeMove(message.payload)));
      },
      () => {},
    )).toEqual(["move 0"]);
    expect(moveResults.at(-1)).toEqual({ ok: true, status: "playing", duplicate: true });
    expect(o.committedTurns).toBe(1);
    expect(o.serialise().moves).toEqual(beforeDuplicate.moves);

    const conflicting = decodeMove(savedX.moves[0]);
    conflicting.cell = 1;
    expect(o.receiveMove(conflicting)).toEqual({
      ok: false,
      reason: "conflicting historical move for turn 0",
    });
    expect(o.committedTurns).toBe(1);

    // O's turn-1 intent is saved but lost. Restore O while it awaits random,
    // replay the intent through X's real verifier/responder, then route X's
    // durable random replay back through O's real reveal verifier.
    o.myIntent();
    const savedO = o.serialise();
    o = PlayerSession.restore(savedO);
    const persisted: { o?: SerializedSession; x?: SerializedSession } = {};

    expect(replayRecoverableMessages(
      o,
      (message: WireOutbound) => {
        if (message.type !== "intent") return;
        expect(x.receiveIntent(decodeIntent(message.payload))).toEqual({ ok: true });
        expect(replayRecoverableMessages(
          x,
          (response) => {
            if (response.type === "random") {
              expect(o.receiveRandomReveal(decodeRandomReveal(response.payload))).toEqual({ ok: true });
            }
          },
          () => { persisted.x = x.serialise(); },
        )).toEqual(["move 0", "random 1"]);
      },
      () => { persisted.o = o.serialise(); },
    )).toEqual(["intent 1"]);

    expect(persisted.o?.intents[1]).not.toBeNull();
    expect(persisted.x?.reveals[1]).not.toBeNull();
    expect(o.turnPhase).toMatchObject({ phase: "act" });
    expect(o.currentTurn).toBe(x.currentTurn);
  }, 60_000);

  it("sends no recoverable message when durable persistence fails", () => {
    const send = vi.fn();
    const session = {
      role: "x",
      gameId: "game",
      moves: [],
      turnPhase: { phase: "awaitRandom" },
      myIntent: () => ({
        channelId: "game",
        turn: 1,
        slot: 0,
        bits: [0, 0, 0, 0],
        secret: new Uint8Array(32),
        path: { leaf: new Uint8Array(32), path: [] },
      }),
    } as unknown as PlayerSession;

    expect(() => replayRecoverableMessages(
      session,
      send,
      () => { throw new Error("storage unavailable"); },
    )).toThrow("storage unavailable");
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps static reconnect available for AI sessions only", () => {
    expect(canReconnectSavedGame(false, true)).toBe(true);
    expect(canReconnectSavedGame(false, false)).toBe(false);
    expect(canReconnectSavedGame(true, false)).toBe(true);
  });
});
