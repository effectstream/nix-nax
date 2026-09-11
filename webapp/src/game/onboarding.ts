// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

import { PlayerSession, type SerializedSession } from "./player-session.ts";
import {
  SessionPersistenceError,
  loadSessionForUpdate,
  markVsAi,
  saveSession,
} from "./storage.ts";

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");

export interface SubmissionResult {
  via: "local";
  txId?: string;
}

export interface JoinState {
  status: number;
  idO: string;
}

export interface PreparedJoin {
  session: PlayerSession;
  reused: boolean;
}

function noSubmissionMessage(error: SessionPersistenceError): Error {
  return new Error(`${error.message} No transaction was submitted.`, { cause: error });
}

export async function createDurableGame(
  session: PlayerSession,
  submit: (args: { gameId: string; idX: string; rootX: string }) => Promise<SubmissionResult>,
  vsAi: boolean,
): Promise<SubmissionResult> {
  try {
    saveSession(session.serialise());
    if (vsAi) markVsAi(session.gameId);
  } catch (error) {
    if (error instanceof SessionPersistenceError) throw noSubmissionMessage(error);
    throw error;
  }

  try {
    return await submit({
      gameId: session.gameId,
      idX: hex(session.keys.id),
      rootX: `0x${session.keys.tokenTree.root.field.toString(16)}`,
    });
  } catch (error) {
    throw new Error(
      `Create failed or confirmation was interrupted: ${(error as Error).message}. ` +
      "Your private credentials remain saved; use Reconnect before creating another game.",
      { cause: error },
    );
  }
}

export function prepareJoin(
  gameId: string,
  create: () => PlayerSession,
  restore: (stored: SerializedSession) => PlayerSession = PlayerSession.restore,
): PreparedJoin {
  let stored: SerializedSession | null;
  try {
    stored = loadSessionForUpdate(gameId, "o");
  } catch (error) {
    if (error instanceof SessionPersistenceError) throw noSubmissionMessage(error);
    throw error;
  }
  return stored
    ? { session: restore(stored), reused: true }
    : { session: create(), reused: false };
}

export async function joinDurably(
  prepared: PreparedJoin,
  submit: (args: { gameId: string; idO: string; rootO: string }) => Promise<SubmissionResult>,
  readState: (gameId: string) => Promise<JoinState>,
): Promise<{ result: SubmissionResult | null; reconciled: boolean }> {
  const { session, reused } = prepared;
  if (!reused) {
    try {
      saveSession(session.serialise());
    } catch (error) {
      if (error instanceof SessionPersistenceError) throw noSubmissionMessage(error);
      throw error;
    }
  }

  const myId = hex(session.keys.id);
  try {
    const result = await submit({
      gameId: session.gameId,
      idO: myId,
      rootO: `0x${session.keys.tokenTree.root.field.toString(16)}`,
    });
    return { result, reconciled: false };
  } catch (submissionError) {
    let state: JoinState;
    try {
      state = await readState(session.gameId);
    } catch (reconciliationError) {
      throw new Error(
        `Join failed and its on-chain outcome could not be confirmed: ${(submissionError as Error).message}. ` +
        "Your private credentials remain saved; use Reconnect to retry reconciliation.",
        { cause: reconciliationError },
      );
    }
    if (state.status === 0) {
      throw new Error(
        `Join was not confirmed: ${(submissionError as Error).message}. ` +
        "Your private credentials remain saved; retry with the same saved identity.",
        { cause: submissionError },
      );
    }
    if (state.idO.toLowerCase() === myId.toLowerCase()) {
      return { result: null, reconciled: true };
    }
    throw new Error(
      "Game is already joined with different credentials. Your saved join identity was preserved for diagnosis; do not overwrite it.",
      { cause: submissionError },
    );
  }
}
