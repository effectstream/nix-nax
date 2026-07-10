// Slim e2e driver (arena edition): the arena contract is deployed ONCE for
// the whole suite (or reused from a prior run via tictactoe.undeployed.json);
// each test opens its own GAME with a fast createGame/joinGame pair, using
// the same deterministic fixtures as the sim tests.

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

// Short challenge/timeout/response floor for the live-stack suite (seconds).
// The contract enforces >(now + this); tests wait it out with a small sleep.
export const E2E_MIN_WINDOW = 5n;

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
      // stale local dust set — see .stack-logs/midnight-node.log).
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
      privateStateStoreName: "ttt-e2e-arena",
      midnightDbName: "tictactoe-level-db-e2e-arena",
      // Short window so the suite doesn't wait out real 10-minute deadlines, in
      // its own deployment file so it never reuses (or clobbers) the main arena.
      minWindowSecs: E2E_MIN_WINDOW,
      deploymentFile: path.resolve(
        fileURLToPath(new URL("../../tictactoe.e2e.json", import.meta.url)),
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
  hasDeadline: boolean;
  hasChallenge: boolean;
}

export interface GameHandle {
  gameId: Uint8Array;
  contractAddress: string;
  settleChunk(baseTurn: number, moves: ScriptMove[], untilTime: bigint): Promise<string>;
  claimResult(as?: "x" | "o"): Promise<string>;
  startTimeoutAsX(untilTime: bigint): Promise<string>;
  claimTimeout(): Promise<string>;
  proveEquivocationByX(turn: number, a: ScriptMove, b: ScriptMove): Promise<string>;
  readDyn(): Promise<GameDynView>;
  readWinBalance(): Promise<bigint>;
}

export async function openGame(pair: TestPair): Promise<GameHandle> {
  const a = await arena();

  let tx: any = await submitWithRetry("createGame", () => (a.found as any).callTx.createGame(
    pair.gameId, pair.x.id, pair.x.token.root, pair.x.index.root, pair.x.random.root,
  ));
  console.log("createGame tx:", tx.public.txId);
  tx = await submitWithRetry("joinGame", () => (a.found as any).callTx.joinGame(
    pair.gameId, pair.o.id, pair.o.token.root, pair.o.index.root, pair.o.random.root,
  ));
  console.log("joinGame tx:", tx.public.txId);
  // Let the wallet ingest joinGame's dust change before the next tx balances —
  // building immediately can re-spend the same dust nullifier (DustDoubleSpend
  // pre-dispatch rejection, then FeeCalculation on the confused rebuild).
  await new Promise((r) => setTimeout(r, 30_000));

  return {
    gameId: pair.gameId,
    contractAddress: a.contractAddress,
    async settleChunk(baseTurn, moves, untilTime) {
      const c = packChunk(pair, baseTurn, moves);
      const t: any = await submitWithRetry("settle", () => (a.found as any).callTx.settle(
        pair.gameId, c.nMoves, c.parities, c.kinds, c.cells, c.sizes, c.secrets, c.paths, untilTime,
      ));
      return t.public.txId as string;
    },
    // Finalise + mint as the WINNER. `as` selects whose secret authenticates
    // (callerMark): "x" for the happy path, "o" for a fraud/timeout win by O.
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
    async startTimeoutAsX(untilTime) {
      const { found } = await attachWithSecret({
        contractAddress: a.contractAddress,
        wallet: a.wallet,
        secret: pair.x.secret,
        storeSuffix: `e2e-st-${Buffer.from(pair.gameId).toString("hex").slice(0, 8)}`,
      });
      const t: any = await submitWithRetry("startTimeout", () => (found as any).callTx.startTimeout(pair.gameId, untilTime));
      return t.public.txId as string;
    },
    async claimTimeout() {
      const t: any = await submitWithRetry("claimTimeout", () => (a.found as any).callTx.claimTimeout(pair.gameId));
      return t.public.txId as string;
    },
    async proveEquivocationByX(turn, x1, x2) {
      const { secretFor } = await import("../../src/sdk/crypto/token-tree.ts");
      const t = await submitWithRetry("proveEquivocationByX", () => (a.found as any).callTx.proveEquivocationByX(
        pair.gameId,
        BigInt(turn),
        BigInt(x1.kind), BigInt(x1.cell), BigInt(x1.size),
        secretFor(pair.x.token, turn, x1.kind, x1.cell, x1.size),
        pair.x.token.pathFor(turn, x1.kind, x1.cell, x1.size),
        BigInt(x2.kind), BigInt(x2.cell), BigInt(x2.size),
        secretFor(pair.x.token, turn, x2.kind, x2.cell, x2.size),
        pair.x.token.pathFor(turn, x2.kind, x2.cell, x2.size),
      )) as any;
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
        hasDeadline: d.hasDeadline as boolean,
        hasChallenge: d.hasChallenge as boolean,
      };
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
