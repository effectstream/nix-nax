// Client-side arena (contract) module — the serverless replacement for
// webapp/src/api/http.ts. Every action is built, proven, balanced, and submitted
// in the browser via the in-browser gas wallet (see wallet/local-wallet.ts); no
// relay. Exposes an `api`-shaped object so the consumers (submit.ts,
// useChainActions.ts, GameView, Home) just swap their import.
//
// Codecs + the per-action argument order are ported verbatim from the old
// relay/server.ts so the on-chain calls are byte-identical.

import { findDeployedContract } from "@midnight-ntwrk/midnight-js-contracts";
import { encodeCoinPublicKey, rawTokenType } from "@midnight-ntwrk/compact-runtime";
import { firstValueFrom } from "rxjs";
import { createNixNaxPrivateState, ledger } from "../../../src/contract/index.ts";
import { buildBrowserProviders, buildConnectorProviders } from "./providers.ts";
import { ARENA_ADDRESS, IS_UNDEPLOYED, NETWORK_ID } from "./env.ts";
import { makeCompiled, PRIVATE_STATE_ID } from "./compiled.ts";
import { getGasWallet } from "../wallet/local-wallet.ts";
import { walletApi } from "../wallet/useWallet.ts";
import { logEvent } from "../game/log-store.ts";

// ── Wire types (identical to the old api/http.ts) ───────────────────────────
export type WirePath = { leaf: string; path: { sibling: string; goes_left: boolean }[] };

export interface ContractState {
  ok: true;
  gameId: string;
  status: number;
  statusName: "halfOpen" | "inProgress" | "settled";
  winner: number;
  winnerName: "none" | "x" | "o" | "draw";
  idX: string;
  idO: string;
  rootX: string;
  rootO: string;
  rootIdxX: string;
  rootIdxO: string;
  rootRndX: string;
  rootRndO: string;
  committedTurns: number;
  turnMark: number;
  hasChallenge: boolean;
  challengeUntil: string;
  hasDeadline: boolean;
  deadline: string;
  hasRollChallenge: boolean;
  challengeTurn: number;
  respondBy: string;
  board: number[];
  tops: number[];
  reserves: Record<string, number>;
  actionLog: { turn: number; packed: number }[];
}

export interface SettleChunkBody {
  gameId: string;
  secret: string;
  nMoves: number;
  parities: number[];
  kinds: number[];
  cells: number[];
  sizes: number[];
  secrets: string[];
  paths: WirePath[];
  untilTime: string;
}

// ── Codecs (ported from relay/server.ts) ────────────────────────────────────
const fromHex = (s: string): Uint8Array => {
  const h = (s.startsWith("0x") ? s.slice(2) : s).match(/.{1,2}/g) ?? [];
  return new Uint8Array(h.map((b) => parseInt(b, 16)));
};
const toHex = (b: Uint8Array): string =>
  Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const fieldBig = (v: string | number | bigint): bigint => BigInt(v);
const gid = (s: string): Uint8Array => {
  const b = fromHex(s);
  if (b.length !== 32) throw new Error("gameId must be 32 bytes of hex");
  return b;
};
const bits4 = (xs: number[]): [bigint, bigint, bigint, bigint] => {
  if (!Array.isArray(xs) || xs.length !== 4) throw new Error("bits must be a 4-element array");
  return [BigInt(xs[0]), BigInt(xs[1]), BigInt(xs[2]), BigInt(xs[3])];
};
const toBig = (xs: number[]) => xs.map((v) => BigInt(v));
function decodePath(p: WirePath): { leaf: Uint8Array; path: { sibling: { field: bigint }; goes_left: boolean }[] } {
  return {
    leaf: fromHex(p.leaf),
    path: p.path.map((e) => ({ sibling: { field: BigInt(e.sibling) }, goes_left: e.goes_left })),
  };
}
const txIdOf = (tx: any): string => String(tx.public.txId);

// ── Submit serialization: one gas wallet → one nonce/UTXO stream → one queue.
// (Matches the relay's withLock; matters in single-tab vs-AI where the human and
// the AI both submit through the same wallet.)
let queue: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.then(() => undefined, () => undefined);
  return run;
}

// ── Attach (lazy + cached) ──────────────────────────────────────────────────
// Address resolution: a build-time VITE_ARENA_ADDRESS(_<NETWORK>) wins; the
// /arena.json artifact written by `bun run deploy` is the dev fallback and is
// refused off-network (its address would belong to a different chain).
let arenaAddrP: Promise<string> | null = null;
function arenaAddress(): Promise<string> {
  if (!arenaAddrP) {
    if (ARENA_ADDRESS) {
      arenaAddrP = Promise.resolve(ARENA_ADDRESS);
    } else if (!IS_UNDEPLOYED) {
      return Promise.reject(
        new Error(`no arena address configured for network "${NETWORK_ID}" — set VITE_ARENA_ADDRESS_${NETWORK_ID.toUpperCase()} in the root .env and rebuild`),
      );
    } else {
      arenaAddrP = fetch("/arena.json")
        .then((r) => r.json())
        .then((j) => j.contractAddress as string);
    }
  }
  return arenaAddrP;
}

// True when a browser-extension wallet is connected — route through it (it pays
// its own gas). Otherwise use the local session/genesis wallet (undeployed dev).
const useConnector = (): boolean => walletApi() !== null;

// Build the provider set for the active wallet mode: a connected extension
// (Lace) via the DApp-connector adapter, or the local WalletBundle.
async function providersForMode(opts?: { privateStateStoreName?: string; midnightDbName?: string }): Promise<any> {
  const wapi = walletApi();
  if (wapi) return buildConnectorProviders({ api: wapi, ...opts });
  // On a hosted network the ONLY way to pay gas is a connected extension wallet
  // — fail with the actual remedy instead of the genesis wallet's error.
  if (!IS_UNDEPLOYED) {
    throw new Error(`no browser wallet connected — open Wallet (top-right) and connect one on "${NETWORK_ID}"`);
  }
  const wallet = await getGasWallet();
  return buildBrowserProviders({ wallet, ...opts });
}

let handleP: Promise<{ found: any; providers: any; addr: string }> | null = null;
async function attach(): Promise<{ found: any; providers: any; addr: string }> {
  if (handleP) return handleP;
  const p = (async () => {
    const providers = await providersForMode();
    const addr = await arenaAddress();
    const found = await findDeployedContract(providers as any, {
      contractAddress: addr,
      compiledContract: makeCompiled() as any,
      privateStateId: PRIVATE_STATE_ID as any,
      initialPrivateState: createNixNaxPrivateState(new Uint8Array(32)) as any,
    } as any);
    return { found, providers, addr };
  })();
  // NEVER cache a rejection: Home polls saved sessions at page load, BEFORE a
  // wallet is connected — on a hosted network that first attach fails, and a
  // cached rejection would poison every later action (create/join after the
  // user connects). Retry fresh on the next call instead.
  p.catch(() => { if (handleP === p) handleP = null; });
  handleP = p;
  return p;
}

// Drop the cached handle so the next action re-attaches — e.g. after the faucet
// swaps the active gas wallet (setGasWallet) to a funded session wallet.
export function resetArena(): void {
  handleP = null;
}

// A separate handle with the caller's secret in private state — startTimeout
// consumes the localSecret witness (mirrors src/sdk/deploy.ts attachWithSecret).
async function attachWithSecret(secret: Uint8Array): Promise<{ found: any }> {
  const addr = await arenaAddress();
  const providers = await providersForMode({
    privateStateStoreName: "nixnax-arena-secret",
    midnightDbName: "nixnax-web-db-secret",
  });
  const found = await findDeployedContract(providers as any, {
    contractAddress: addr,
    compiledContract: makeCompiled() as any,
    privateStateId: PRIVATE_STATE_ID as any,
    initialPrivateState: createNixNaxPrivateState(secret) as any,
  } as any);
  return { found };
}

// ── On-chain state read (ported from relay /api/state) ──────────────────────
async function readState(gameId: string): Promise<ContractState> {
  const { providers, addr } = await attach();
  const g = gid(gameId);
  const cstate = await (providers.publicDataProvider as any).queryContractState(addr);
  if (!cstate) throw new Error("contract state not found at " + addr);
  const led: any = ledger((cstate as any).data ?? cstate);
  if (!led.gameKeys.member(g)) throw new Error("no such game");

  const keys = led.gameKeys.lookup(g);
  const dyn = led.gameState.lookup(g);

  const innerBoard = led.boards.lookup(g);
  const board: number[] = [];
  for (let k = 0; k < 64; k++) {
    const key = BigInt(k);
    board.push(innerBoard.member(key) ? Number(innerBoard.lookup(key)) : 0);
  }
  const innerTops = led.tops.lookup(g);
  const tops: number[] = [];
  for (let c = 0; c < 16; c++) {
    const key = BigInt(c);
    tops.push(innerTops.member(key) ? Number(innerTops.lookup(key)) : 0);
  }
  const innerRes = led.reserves.lookup(g);
  const reserves: Record<string, number> = {};
  for (const mark of [1, 2]) {
    for (let s = 0; s < 4; s++) {
      const key = BigInt(mark * 4 + s);
      reserves[`${mark === 1 ? "x" : "o"}${s}`] = innerRes.member(key) ? Number(innerRes.lookup(key)) : 0;
    }
  }
  const innerLog = led.actionLogs.lookup(g);
  const actionLog: { turn: number; packed: number }[] = [];
  for (const [turn, packed] of innerLog) actionLog.push({ turn: Number(turn), packed: Number(packed) });
  actionLog.sort((a, b) => a.turn - b.turn);

  return {
    ok: true,
    gameId,
    status: dyn.status,
    statusName: (["halfOpen", "inProgress", "settled"][dyn.status] ?? `?(${dyn.status})`) as ContractState["statusName"],
    winner: dyn.winner,
    winnerName: ["none", "x", "o", "draw"][dyn.winner] as ContractState["winnerName"],
    idX: toHex(keys.idX),
    idO: toHex(keys.idO),
    rootX: "0x" + keys.rootX.field.toString(16),
    rootO: "0x" + keys.rootO.field.toString(16),
    rootIdxX: "0x" + keys.rootIdxX.field.toString(16),
    rootIdxO: "0x" + keys.rootIdxO.field.toString(16),
    rootRndX: "0x" + keys.rootRndX.field.toString(16),
    rootRndO: "0x" + keys.rootRndO.field.toString(16),
    committedTurns: Number(dyn.committedTurns),
    turnMark: Number(dyn.turnMark),
    hasChallenge: dyn.hasChallenge,
    challengeUntil: dyn.challengeUntil.toString(),
    hasDeadline: dyn.hasDeadline,
    deadline: dyn.deadline.toString(),
    hasRollChallenge: dyn.hasRollChallenge,
    challengeTurn: Number(dyn.challengeTurn),
    respondBy: dyn.respondBy.toString(),
    board,
    tops,
    reserves,
    actionLog,
  };
}

// ── Win-token (shielded reward) ─────────────────────────────────────────────
// claimResult mints 1 "nixnax:win" shielded token to the winner's gas wallet.
// Its color = tokenType(pad(32,"nixnax:win"), contractAddress) on-chain; a
// wallet's balance of that token = its number of wins. The domain separator
// must match the contract's pad(32,"nixnax:win") byte-for-byte (string bytes
// first, zero-filled to 32).
const WIN_DOMAIN = "nixnax:win";
const pad32 = (s: string): Uint8Array => {
  const b = new TextEncoder().encode(s);
  if (b.length > 32) throw new Error("domain separator > 32 bytes");
  const out = new Uint8Array(32);
  out.set(b, 0);
  return out;
};

// The win-token's raw type string — the key under wallet.state().shielded.balances.
export async function winTokenRaw(): Promise<string> {
  return rawTokenType(pad32(WIN_DOMAIN), await arenaAddress());
}

// How many win-tokens the active gas wallet holds (= wins). Reads the live
// wallet state. Robust to the exact balances-key shape: prefers the precisely
// derived raw key, else falls back to the sole custom (non-native) shielded
// balance — the win-token is the only shielded token this dApp ever mints.
export async function readWinBalance(): Promise<number> {
  try {
    let balances: Record<string, bigint>;
    const wapi = walletApi();
    if (wapi) {
      // Connected extension wallet: ask it directly for shielded balances.
      balances = await wapi.getShieldedBalances();
    } else {
      const bundle = await getGasWallet();
      const st: any = await firstValueFrom((bundle as any).wallet.state());
      balances = st?.shielded?.balances ?? {};
    }
    const raw = await winTokenRaw();
    const keys = Object.keys(balances);
    let n = balances[raw];
    if (n == null) {
      // Fallback: sum non-native shielded balances (native shielded tag = 'shielded').
      let sum = 0n;
      for (const [k, v] of Object.entries(balances)) if (k !== "shielded") sum += v ?? 0n;
      n = sum;
    }
    logEvent(`wins: ${n} (raw ${raw.slice(0, 16)}…; shielded keys=[${keys.map((k) => k.slice(0, 10)).join(", ")}])`);
    return Number(n ?? 0n);
  } catch (e) {
    logEvent(`wins: read failed — ${(e as Error).message}`);
    return 0;
  }
}

// ── Public API (mirrors webapp/src/api/http.ts `api`) ───────────────────────
export const api = {
  health: async (): Promise<{ ok: true; arena?: string }> => ({ ok: true, arena: await arenaAddress() }),

  createGame: (args: { gameId: string; idX: string; rootX: string; rootIdxX: string; rootRndX: string }) =>
    withLock(async () => {
      const { found } = await attach();
      const tx = await found.callTx.createGame(
        gid(args.gameId),
        fromHex(args.idX),
        { field: fieldBig(args.rootX) },
        { field: fieldBig(args.rootIdxX) },
        { field: fieldBig(args.rootRndX) },
      );
      return { ok: true as const, txId: txIdOf(tx), gameId: args.gameId };
    }),

  join: (args: { gameId: string; idO: string; rootO: string; rootIdxO: string; rootRndO: string }) =>
    withLock(async () => {
      const { found } = await attach();
      const tx = await found.callTx.joinGame(
        gid(args.gameId),
        fromHex(args.idO),
        { field: fieldBig(args.rootO) },
        { field: fieldBig(args.rootIdxO) },
        { field: fieldBig(args.rootRndO) },
      );
      return { ok: true as const, txId: txIdOf(tx) };
    }),

  state: (gameId: string) => readState(gameId),

  settle: (body: SettleChunkBody) =>
    withLock(async () => {
      const { found } = await attach();
      const tx = await found.callTx.settle(
        gid(body.gameId),
        BigInt(body.nMoves),
        toBig(body.parities),
        toBig(body.kinds),
        toBig(body.cells),
        toBig(body.sizes),
        body.secrets.map(fromHex),
        body.paths.map(decodePath),
        BigInt(body.untilTime),
      );
      return { ok: true as const, txId: txIdOf(tx) };
    }),

  claimResult: (gameId: string, secret: string) =>
    withLock(async () => {
      // Attach with the caller's secret — claimResult reads the localSecret witness
      // (via callerMark) to enforce winner-only finalisation of a decided game — then
      // mint the win-token to the submitting gas wallet (recipient = its shielded coin
      // public key). Draws finalise with no mint; the recipient is then unused.
      const { found } = await attachWithSecret(fromHex(secret));
      const wallet = await getGasWallet();
      const recipient = { bytes: encodeCoinPublicKey((wallet as any).zswapSecretKeys.coinPublicKey) };
      const tx = await found.callTx.claimResult(gid(gameId), recipient);
      return { ok: true as const, txId: txIdOf(tx) };
    }),

  startTimeout: (gameId: string, secret: string, untilTime: string) =>
    withLock(async () => {
      const { found } = await attachWithSecret(fromHex(secret));
      const tx = await found.callTx.startTimeout(gid(gameId), BigInt(untilTime));
      return { ok: true as const, txId: txIdOf(tx) };
    }),

  claimTimeout: (gameId: string) =>
    withLock(async () => {
      const { found } = await attach();
      const tx = await found.callTx.claimTimeout(gid(gameId));
      return { ok: true as const, txId: txIdOf(tx) };
    }),

  proveFraud: (body: {
    gameId: string; side: "x" | "o"; turn: number;
    kindA: number; cellA: number; sizeA: number; secretA: string; pathA: WirePath;
    kindB: number; cellB: number; sizeB: number; secretB: string; pathB: WirePath;
  }) =>
    withLock(async () => {
      const { found } = await attach();
      const fn = body.side === "x" ? "proveEquivocationByX" : "proveEquivocationByO";
      const tx = await found.callTx[fn](
        gid(body.gameId), BigInt(body.turn),
        BigInt(body.kindA), BigInt(body.cellA), BigInt(body.sizeA), fromHex(body.secretA), decodePath(body.pathA),
        BigInt(body.kindB), BigInt(body.cellB), BigInt(body.sizeB), fromHex(body.secretB), decodePath(body.pathB),
      );
      return { ok: true as const, txId: txIdOf(tx) };
    }),

  proveIndexFraud: (body: {
    gameId: string; side: "x" | "o"; turn: number;
    slotA: number; bitsA: number[]; secretA: string; pathA: WirePath;
    slotB: number; bitsB: number[]; secretB: string; pathB: WirePath;
  }) =>
    withLock(async () => {
      const { found } = await attach();
      const fn = body.side === "x" ? "proveIndexEquivocationByX" : "proveIndexEquivocationByO";
      const tx = await found.callTx[fn](
        gid(body.gameId), BigInt(body.turn),
        BigInt(body.slotA), ...bits4(body.bitsA), fromHex(body.secretA), decodePath(body.pathA),
        BigInt(body.slotB), ...bits4(body.bitsB), fromHex(body.secretB), decodePath(body.pathB),
      );
      return { ok: true as const, txId: txIdOf(tx) };
    }),

  proveRandomFraud: (body: {
    gameId: string; side: "x" | "o"; turn: number; slot: number;
    bitsA: number[]; randomA: string; pathA: WirePath;
    bitsB: number[]; randomB: string; pathB: WirePath;
  }) =>
    withLock(async () => {
      const { found } = await attach();
      const fn = body.side === "x" ? "proveRandomEquivocationByX" : "proveRandomEquivocationByO";
      const tx = await found.callTx[fn](
        gid(body.gameId), BigInt(body.turn), BigInt(body.slot),
        ...bits4(body.bitsA), fromHex(body.randomA), decodePath(body.pathA),
        ...bits4(body.bitsB), fromHex(body.randomB), decodePath(body.pathB),
      );
      return { ok: true as const, txId: txIdOf(tx) };
    }),

  proveWrongParity: (body: {
    gameId: string; turn: number; slot: number;
    bitsI: number[]; secretI: string; pathI: WirePath;
    bitsR: number[]; randomR: string; pathR: WirePath;
  }) =>
    withLock(async () => {
      const { found } = await attach();
      const tx = await found.callTx.proveWrongParity(
        gid(body.gameId), BigInt(body.turn), BigInt(body.slot),
        ...bits4(body.bitsI), fromHex(body.secretI), decodePath(body.pathI),
        ...bits4(body.bitsR), fromHex(body.randomR), decodePath(body.pathR),
      );
      return { ok: true as const, txId: txIdOf(tx) };
    }),

  // ── Roll-class dispute (challenge / answer / forfeit) ─────────────────────
  // The responder demands a committed turn's roll evidence (callerMark auth).
  challengeRoll: (gameId: string, secret: string, turn: number, respondBy: string) =>
    withLock(async () => {
      const { found } = await attachWithSecret(fromHex(secret));
      const tx = await found.callTx.challengeRoll(gid(gameId), BigInt(turn), BigInt(respondBy));
      return { ok: true as const, txId: txIdOf(tx) };
    }),

  // Permissionless: the reveals authenticate themselves under both roots.
  answerRollChallenge: (body: {
    gameId: string; slot: number;
    bitsI: number[]; secretI: string; pathI: WirePath;
    bitsR: number[]; randomR: string; pathR: WirePath;
  }) =>
    withLock(async () => {
      const { found } = await attach();
      const tx = await found.callTx.answerRollChallenge(
        gid(body.gameId), BigInt(body.slot),
        ...bits4(body.bitsI), fromHex(body.secretI), decodePath(body.pathI),
        ...bits4(body.bitsR), fromHex(body.randomR), decodePath(body.pathR),
      );
      return { ok: true as const, txId: txIdOf(tx) };
    }),

  claimRollChallenge: (gameId: string) =>
    withLock(async () => {
      const { found } = await attach();
      const tx = await found.callTx.claimRollChallenge(gid(gameId));
      return { ok: true as const, txId: txIdOf(tx) };
    }),
};
