// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

// Slim e2e driver (simplified arena): the arena contract is deployed ONCE for
// the whole suite (or reused from a prior run via nixnax.e2e.json); each test
// opens its own GAME with a fast createGame/joinGame pair, using the same
// deterministic fixtures as the sim tests.

import {
  ensureArenaDeployed,
  attachWithSecret,
  readLedger,
  buildAndFundWallet,
  type ArenaHandle,
} from "../../src/sdk/deploy.ts";
import { encodeCoinPublicKey, rawTokenType } from "@midnight-ntwrk/compact-runtime";
import { firstValueFrom } from "rxjs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { NETWORK } from "../../src/sdk/env.ts";
import { packChunk, type TestPair, type ScriptMove } from "../helpers/fixtures.ts";

// Win-token domain separator — MUST byte-match the contract's pad(32,"nixnax:win").
const WIN_DOMAIN = "nixnax:win";
function pad32(s: string): Uint8Array {
  const b = new TextEncoder().encode(s);
  const out = new Uint8Array(32);
  out.set(b, 0);
  return out;
}

// The local `undeployed` chain intermittently rejects valid txs with
// "1010: Invalid Transaction: Custom error: N" (a known dev-chain flake — the
// midnight canary suites classify these as retryable, not real breaks). Retry
// a couple of times with a pause so one flake doesn't fail a 10-minute suite.
async function submitWithRetry<T>(label: string, fn: () => Promise<T>, tries = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      const flaky = /1010|Custom error|SubmissionError|Transaction submission/i.test(msg);
      lastErr = e;
      if (!flaky || i === tries - 1) throw e;
      // 45s: long enough for the wallet to ingest the previous tx's dust change
      // (the usual root cause is a DustDoubleSpend from balancing against a
      // stale local dust set — see `docker compose … logs node`).
      console.log(`${label}: transient submission error (attempt ${i + 1}/${tries}) — retrying in 45s…`);
      await new Promise((r) => setTimeout(r, 45_000));
    }
  }
  throw lastErr;
}

let arenaPromise: Promise<ArenaHandle> | null = null;
function arena(): Promise<ArenaHandle> {
  arenaPromise ??= (async () => {
    const wallet = await buildAndFundWallet(
      NETWORK,
      process.env.MIDNIGHT_WALLET_SEED ??
        "0000000000000000000000000000000000000000000000000000000000000001",
    );
    return ensureArenaDeployed({
      wallet,
      privateStateStoreName: "nixnax-e2e-arena",
      midnightDbName: "nixnax-level-db-e2e-arena",
      // Own deployment file so it never reuses (or clobbers) the main arena.
      deploymentFile: path.resolve(
        fileURLToPath(new URL("../../nixnax.e2e.json", import.meta.url)),
      ),
    });
  })();
  return arenaPromise;
}

export interface GameDynView {
  status: number;
  winner: number;
  committedTurns: number;
  turnMark: number;
}

export interface GameHandle {
  gameId: Uint8Array;
  contractAddress: string;
  settleChunk(baseTurn: number, moves: ScriptMove[]): Promise<string>;
  claimResult(as?: "x" | "o"): Promise<string>;
  readDyn(): Promise<GameDynView>;
  readAction(turn: number): Promise<number | null>;
  readTop(cell: number): Promise<number>;
  readReserve(mark: number, size: number): Promise<number>;
  readWinBalance(): Promise<bigint>;
}

export async function openGame(pair: TestPair): Promise<GameHandle> {
  const a = await arena();

  let tx: any = await submitWithRetry("createGame", () => (a.found as any).callTx.createGame(
    pair.gameId, pair.x.id, pair.x.token.root,
  ));
  console.log("createGame tx:", tx.public.txId);
  tx = await submitWithRetry("joinGame", () => (a.found as any).callTx.joinGame(
    pair.gameId, pair.o.id, pair.o.token.root,
  ));
  console.log("joinGame tx:", tx.public.txId);
  // Let the wallet ingest joinGame's dust change before the next tx balances —
  // building immediately can re-spend the same dust nullifier (DustDoubleSpend
  // pre-dispatch rejection, then FeeCalculation on the confused rebuild).
  await new Promise((r) => setTimeout(r, 30_000));

  return {
    gameId: pair.gameId,
    contractAddress: a.contractAddress,
    async settleChunk(baseTurn, moves) {
      const c = packChunk(pair, baseTurn, moves);
      const t: any = await submitWithRetry("settle", () => (a.found as any).callTx.settle(
        pair.gameId, c.nMoves, c.kinds, c.cells, c.sizes, c.secrets, c.paths,
      ));
      return t.public.txId as string;
    },
    // Finalise + mint as the WINNER. `as` selects whose secret authenticates
    // (callerMark): "x" or "o".
    async claimResult(as: "x" | "o" = "x") {
      const { found } = await attachWithSecret({
        contractAddress: a.contractAddress,
        wallet: a.wallet,
        secret: as === "x" ? pair.x.secret : pair.o.secret,
        storeSuffix: `e2e-cr-${as}-${Buffer.from(pair.gameId).toString("hex").slice(0, 8)}`,
      });
      const recipient = { bytes: encodeCoinPublicKey((a.wallet as any).zswapSecretKeys.coinPublicKey) };
      const t: any = await submitWithRetry("claimResult", () => (found as any).callTx.claimResult(pair.gameId, recipient));
      return t.public.txId as string;
    },
    async readDyn() {
      const led = await readLedger(a.providers, a.contractAddress);
      const d = (led as any).gameState.lookup(pair.gameId);
      return {
        status: d.status as number,
        winner: d.winner as number,
        committedTurns: Number(d.committedTurns),
        turnMark: Number(d.turnMark),
      };
    },
    async readAction(turn) {
      const led = await readLedger(a.providers, a.contractAddress);
      const log = (led as any).actionLogs.lookup(pair.gameId);
      return log.member(BigInt(turn)) ? Number(log.lookup(BigInt(turn))) : null;
    },
    async readTop(cell) {
      const led = await readLedger(a.providers, a.contractAddress);
      const tops = (led as any).tops.lookup(pair.gameId);
      return tops.member(BigInt(cell)) ? Number(tops.lookup(BigInt(cell))) : 0;
    },
    async readReserve(mark, size) {
      const led = await readLedger(a.providers, a.contractAddress);
      return Number((led as any).reserves.lookup(pair.gameId).lookup(BigInt(mark * 4 + size)));
    },
    // The suite wallet's balance of THIS arena's "nixnax:win" shielded token.
    // Exact raw-key lookup only — a fuzzy fallback (summing other balances)
    // would pick up unrelated shielded tokens and make assertions meaningless.
    async readWinBalance() {
      const st: any = await firstValueFrom((a.wallet as any).wallet.state());
      const balances: Record<string, bigint> = st?.shielded?.balances ?? {};
      const raw = rawTokenType(pad32(WIN_DOMAIN), a.contractAddress);
      return (balances[raw] as bigint) ?? 0n;
    },
  };
}
