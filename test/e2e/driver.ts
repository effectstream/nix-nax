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
import { encodeCoinPublicKey } from "@midnight-ntwrk/compact-runtime";
import { NETWORK } from "../../src/sdk/env.ts";
import { packChunk, type TestPair, type ScriptMove } from "../helpers/fixtures.ts";

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
  claimResult(): Promise<string>;
  startTimeoutAsX(untilTime: bigint): Promise<string>;
  claimTimeout(): Promise<string>;
  proveEquivocationByX(turn: number, a: ScriptMove, b: ScriptMove): Promise<string>;
  readDyn(): Promise<GameDynView>;
}

export async function openGame(pair: TestPair): Promise<GameHandle> {
  const a = await arena();

  let tx = await (a.found as any).callTx.createGame(
    pair.gameId, pair.x.id, pair.x.token.root, pair.x.index.root, pair.x.random.root,
  );
  console.log("createGame tx:", tx.public.txId);
  tx = await (a.found as any).callTx.joinGame(
    pair.gameId, pair.o.id, pair.o.token.root, pair.o.index.root, pair.o.random.root,
  );
  console.log("joinGame tx:", tx.public.txId);

  return {
    gameId: pair.gameId,
    contractAddress: a.contractAddress,
    async settleChunk(baseTurn, moves, untilTime) {
      const c = packChunk(pair, baseTurn, moves);
      const t = await (a.found as any).callTx.settle(
        pair.gameId, c.nMoves, c.parities, c.kinds, c.cells, c.sizes, c.secrets, c.paths, untilTime,
      );
      return t.public.txId as string;
    },
    async claimResult() {
      // Winner-only now: attach with X's secret (callerMark) and mint the
      // win-token to X's wallet (recipient = its shielded coin public key).
      const { found } = await attachWithSecret({
        contractAddress: a.contractAddress,
        wallet: a.wallet,
        secret: pair.x.secret,
        storeSuffix: `e2e-cr-${Buffer.from(pair.gameId).toString("hex").slice(0, 8)}`,
      });
      const recipient = { bytes: encodeCoinPublicKey((a.wallet as any).zswapSecretKeys.coinPublicKey) };
      const t = await (found as any).callTx.claimResult(pair.gameId, recipient);
      return t.public.txId as string;
    },
    async startTimeoutAsX(untilTime) {
      const { found } = await attachWithSecret({
        contractAddress: a.contractAddress,
        wallet: a.wallet,
        secret: pair.x.secret,
        storeSuffix: `e2e-st-${Buffer.from(pair.gameId).toString("hex").slice(0, 8)}`,
      });
      const t = await (found as any).callTx.startTimeout(pair.gameId, untilTime);
      return t.public.txId as string;
    },
    async claimTimeout() {
      const t = await (a.found as any).callTx.claimTimeout(pair.gameId);
      return t.public.txId as string;
    },
    async proveEquivocationByX(turn, x1, x2) {
      const { secretFor } = await import("../../src/sdk/crypto/token-tree.ts");
      const t = await (a.found as any).callTx.proveEquivocationByX(
        pair.gameId,
        BigInt(turn),
        BigInt(x1.kind), BigInt(x1.cell), BigInt(x1.size),
        secretFor(pair.x.token, turn, x1.kind, x1.cell, x1.size),
        pair.x.token.pathFor(turn, x1.kind, x1.cell, x1.size),
        BigInt(x2.kind), BigInt(x2.cell), BigInt(x2.size),
        secretFor(pair.x.token, turn, x2.kind, x2.cell, x2.size),
        pair.x.token.pathFor(turn, x2.kind, x2.cell, x2.size),
      );
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
  };
}
