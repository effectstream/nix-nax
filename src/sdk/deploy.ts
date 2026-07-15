// Arena deploy + attach helpers. The NixNaxArena contract is deployed ONCE
// per chain (small stub tx + one maintenance tx per verifier key, see
// NixNaxArenaStub.compact); afterwards every game is a fast `createGame`
// circuit call. The deployment address is persisted and revalidated against
// the chain on boot, so relay restarts reuse it.

import {
  deployContract,
  findDeployedContract,
  submitInsertVerifierKeyTx,
  createUnprovenCallTx,
} from "@midnight-ntwrk/midnight-js-contracts";
import { CompiledContract } from "@midnight-ntwrk/compact-js";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import * as path from "node:path";
import { writeFile, readFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  Contract,
  createWitnesses,
  createNixNaxPrivateState,
  type NixNaxPrivateState,
  ledger,
} from "../contract/index.ts";
import { Contract as StubContract } from "../contract/managed-stub/contract/index.js";
import { NETWORK } from "./env.ts";
import { buildProviders } from "./providers.ts";
import { buildAndFundWallet, type WalletBundle } from "./wallet.ts";

const log = console;

const ARTIFACTS_DIR = path.resolve(
  fileURLToPath(new URL("../contract/managed", import.meta.url))
);
const STUB_ARTIFACTS_DIR = path.resolve(
  fileURLToPath(new URL("../contract/managed-stub", import.meta.url))
);

// Anchored to the repo root (not the process CWD) so every entrypoint —
// relay, stack scripts, e2e driver — sees the same persisted deployment.
export const DEPLOYMENT_FILE = process.env.MIDNIGHT_DEPLOYMENT_FILE
  ? path.resolve(process.env.MIDNIGHT_DEPLOYMENT_FILE)
  : path.resolve(fileURLToPath(new URL("../..", import.meta.url)), "nixnax.undeployed.json");

const DEFAULT_PRIVATE_STATE_ID = "nixnaxArena";

function makeCompiled() {
  return CompiledContract.make("nixnax-arena", Contract as any).pipe(
    CompiledContract.withWitnesses(createWitnesses() as never),
    CompiledContract.withCompiledFileAssets(ARTIFACTS_DIR),
  );
}

function makeCompiledStub() {
  return CompiledContract.make("nixnax-arena", StubContract as any).pipe(
    CompiledContract.withWitnesses({} as never),
    CompiledContract.withCompiledFileAssets(STUB_ARTIFACTS_DIR),
  );
}

async function waitForOperation(providers: any, contractAddress: string, circuitId: string) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const st = await providers.publicDataProvider.queryContractState(contractAddress);
    if (st && st.operation(circuitId) !== undefined) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`verifier key for '${circuitId}' not visible on-chain after 120s`);
}

export interface ArenaHandle {
  contractAddress: string;
  wallet: WalletBundle;
  providers: ReturnType<typeof buildProviders>;
  found: any; // findDeployedContract handle — callTx.* for all circuits
  reused: boolean;
}

// Deploy (or reuse) the arena and return a CACHED call handle. Safe to call
// once at service boot; per-call attach is no longer needed.
// Default minimum challenge/timeout/response window (block-time seconds), set
// at deployment into the contract's sealed `minWindowSecs`. 600 = 10 min is a
// sane production floor; the e2e driver overrides it with a small value so the
// suite doesn't wait out real 10-minute windows.
export const DEFAULT_MIN_WINDOW_SECS = 600n;

export async function ensureArenaDeployed(opts: {
  wallet: WalletBundle;
  privateStateStoreName?: string;
  midnightDbName?: string;
  minWindowSecs?: bigint;
  // Override the persisted-deployment path — lets an isolated caller (e2e) keep
  // its own short-window arena separate from the main/webapp deployment.
  deploymentFile?: string;
}): Promise<ArenaHandle> {
  const deploymentFile = opts.deploymentFile ?? DEPLOYMENT_FILE;
  setNetworkId(NETWORK.networkId);
  const providers = buildProviders({
    wallet: opts.wallet,
    zkConfigPath: ARTIFACTS_DIR,
    privateStateStoreName: opts.privateStateStoreName ?? "nixnax-arena",
    networkUrls: NETWORK,
    midnightDbName: opts.midnightDbName ?? "nixnax-level-db-arena",
  });

  // Reuse a persisted deployment if the chain still knows it AND it has all
  // circuits installed (a partially-inserted deploy is redone from scratch).
  const circuitIds = Object.keys(new (Contract as any)(createWitnesses()).impureCircuits ?? {});
  let contractAddress: string | null = null;
  let reused = false;
  if (existsSync(deploymentFile)) {
    try {
      const saved = JSON.parse(await readFile(deploymentFile, "utf8")) as { contractAddress?: string };
      if (saved.contractAddress) {
        const st = await (providers.publicDataProvider as any).queryContractState(saved.contractAddress);
        if (st && circuitIds.every((id) => st.operation(id) !== undefined)) {
          contractAddress = saved.contractAddress;
          reused = true;
          log.info(`Arena ready (reused) at ${contractAddress}`);
        }
      }
    } catch {
      // fall through to a fresh deploy
    }
  }

  if (!contractAddress) {
    log.info(`Deploying NixNaxArena stub (artifacts: ${STUB_ARTIFACTS_DIR})…`);
    const deployed = await deployContract(providers as any, {
      compiledContract: makeCompiledStub() as any,
      privateStateId: DEFAULT_PRIVATE_STATE_ID as any,
      initialPrivateState: createNixNaxPrivateState(new Uint8Array(32)) as any,
      args: [opts.minWindowSecs ?? DEFAULT_MIN_WINDOW_SECS],
    } as any);
    contractAddress = (deployed as any).deployTxData.public.contractAddress as string;
    log.info(`Deployed (no circuits yet) at ${contractAddress}`);

    const fullCompiled = makeCompiled();
    for (const circuitId of circuitIds) {
      const vk = await (providers as any).zkConfigProvider.getVerifierKey(circuitId);
      log.info(`Inserting verifier key for '${circuitId}'…`);
      await submitInsertVerifierKeyTx(
        providers as any,
        fullCompiled as any,
        contractAddress,
        circuitId as never,
        vk,
      );
      await waitForOperation(providers, contractAddress, circuitId);
    }
    log.info(`All ${circuitIds.length} verifier keys installed at ${contractAddress}`);
    await writeFile(deploymentFile, JSON.stringify({ contractAddress }, null, 2));
  }

  const found = await findDeployedContract(providers as any, {
    contractAddress: contractAddress as any,
    compiledContract: makeCompiled() as any,
    privateStateId: DEFAULT_PRIVATE_STATE_ID as any,
    initialPrivateState: createNixNaxPrivateState(new Uint8Array(32)) as any,
  } as any);

  return { contractAddress, wallet: opts.wallet, providers, found, reused };
}

// Upgrade an EXISTING arena in place: install verifier keys for circuits the
// deployment doesn't have yet (e.g. new settle variants added after deploy).
// Maintenance txs must be signed with the contract's maintenance key, which
// lives in the ORIGINAL deployer's signing-key store — run this with the same
// store/db names (and on the same machine) as the deploy that created the
// arena. No proof server needed: VK inserts are signed maintenance txs.
export async function insertMissingVerifierKeys(opts: {
  wallet: WalletBundle;
  contractAddress: string;
  privateStateStoreName?: string;
  midnightDbName?: string;
}): Promise<{ inserted: string[]; present: string[] }> {
  setNetworkId(NETWORK.networkId);
  const providers = buildProviders({
    wallet: opts.wallet,
    zkConfigPath: ARTIFACTS_DIR,
    privateStateStoreName: opts.privateStateStoreName ?? "nixnax-arena",
    networkUrls: NETWORK,
    midnightDbName: opts.midnightDbName ?? "nixnax-level-db-arena",
  });
  const st = await (providers.publicDataProvider as any).queryContractState(opts.contractAddress);
  if (!st) throw new Error(`no contract on-chain at ${opts.contractAddress}`);
  const circuitIds = Object.keys(new (Contract as any)(createWitnesses()).impureCircuits ?? {});
  const missing = circuitIds.filter((id) => st.operation(id) === undefined);
  const present = circuitIds.filter((id) => st.operation(id) !== undefined);
  if (missing.length === 0) {
    log.info(`All ${circuitIds.length} circuits already installed — nothing to do.`);
    return { inserted: [], present };
  }
  log.info(`Missing on-chain: ${missing.join(", ")} (${present.length} present)`);
  const fullCompiled = makeCompiled();
  for (const circuitId of missing) {
    const vk = await (providers as any).zkConfigProvider.getVerifierKey(circuitId);
    log.info(`Inserting verifier key for '${circuitId}'…`);
    await submitInsertVerifierKeyTx(
      providers as any,
      fullCompiled as any,
      opts.contractAddress,
      circuitId as never,
      vk,
    );
    await waitForOperation(providers, opts.contractAddress, circuitId);
  }
  log.info(`Upgrade complete: ${missing.length} verifier key(s) installed at ${opts.contractAddress}`);
  return { inserted: missing, present };
}

// Build a PROVEN but UNBOUND, dust-less call tx (no fees, NOT submitted) and
// return it hex-serialized. A connected browser wallet then balances the dust
// + submits it — so the PLAYER pays their own gas. Relay-pays actions keep
// using the cached `found.callTx.*` path (which balances dust + submits here).
const toHexStr = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
export async function buildDustlessCallTxHex(
  handle: ArenaHandle,
  circuitId: string,
  args: unknown[],
): Promise<string> {
  const providers = handle.providers as any;
  providers.privateStateProvider?.setContractAddress?.(handle.contractAddress);
  const unsub: any = await createUnprovenCallTx(providers, {
    compiledContract: makeCompiled() as any,
    contractAddress: handle.contractAddress as any,
    circuitId: circuitId as any,
    args: args as any,
    privateStateId: DEFAULT_PRIVATE_STATE_ID as any,
  } as any);
  const unproven = unsub.private?.unprovenTx ?? unsub.public?.unprovenTx ?? unsub.unprovenTx;
  const proven: any = await providers.proofProvider.proveTx(unproven);
  return toHexStr(proven.serialize() as Uint8Array);
}

// A fresh attach with a specific player secret in private state — needed by
// startTimeout, whose circuit consumes the localSecret witness.
export async function attachWithSecret(opts: {
  contractAddress: string;
  wallet: WalletBundle;
  secret: Uint8Array;
  storeSuffix: string;
}) {
  setNetworkId(NETWORK.networkId);
  const providers = buildProviders({
    wallet: opts.wallet,
    zkConfigPath: ARTIFACTS_DIR,
    privateStateStoreName: `nixnax-arena-${opts.storeSuffix}`,
    networkUrls: NETWORK,
    midnightDbName: `nixnax-level-db-${opts.storeSuffix}`,
  });
  const found = await findDeployedContract(providers as any, {
    contractAddress: opts.contractAddress as any,
    compiledContract: makeCompiled() as any,
    privateStateId: DEFAULT_PRIVATE_STATE_ID as any,
    initialPrivateState: createNixNaxPrivateState(opts.secret) as any,
  } as any);
  return { found, providers };
}

// Read the full on-chain ledger projection.
export async function readLedger(
  providers: ReturnType<typeof buildProviders>,
  contractAddress: string,
) {
  const state = await (providers.publicDataProvider as any).queryContractState(contractAddress);
  if (!state) throw new Error("contract state not found at " + contractAddress);
  return ledger((state as any).data ?? state);
}

export async function loadDeployedAddress(): Promise<string | null> {
  if (!existsSync(DEPLOYMENT_FILE)) return null;
  const raw = await readFile(DEPLOYMENT_FILE, "utf8");
  return (JSON.parse(raw) as { contractAddress: string }).contractAddress;
}

export { buildAndFundWallet };
export type { WalletBundle };

// Ensure the deploy file's parent dir exists if a custom path was set.
{
  const dir = path.dirname(DEPLOYMENT_FILE);
  if (dir && dir !== "." && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}
