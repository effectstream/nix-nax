// Deploy + attach helpers for the TicTacToeChannel contract.
//
// Wraps midnight-js's `deployContract` / `findDeployedContract` with the
// project-specific compiled-contract + witnesses + private-state defaults.

import { deployContract, findDeployedContract } from "@midnight-ntwrk/midnight-js-contracts";
import { CompiledContract } from "@midnight-ntwrk/compact-js";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import * as path from "node:path";
import { writeFile, readFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  Contract,
  createWitnesses,
  createTicTacToePrivateState,
  type TicTacToePrivateState,
  ledger,
} from "../contract/index.ts";
import { NETWORK } from "./env.ts";
import { buildProviders } from "./providers.ts";
import { buildAndFundWallet, type WalletBundle } from "./wallet.ts";

const log = console;

// Resolve the path to compiled artifacts (src/contract/managed/) regardless of CWD.
const ARTIFACTS_DIR = path.resolve(
  fileURLToPath(new URL("../contract/managed", import.meta.url))
);

export const DEPLOYMENT_FILE = path.resolve(
  process.env.MIDNIGHT_DEPLOYMENT_FILE || "tictactoe.undeployed.json"
);

export type DeployArgs = {
  idX: Uint8Array;
  rootX: { field: bigint };
};

export type DeploymentResult = {
  contractAddress: string;
  wallet: WalletBundle;
  providers: ReturnType<typeof buildProviders>;
};

export type JoinArgs = {
  idO: Uint8Array;
  rootO: { field: bigint };
};

const DEFAULT_PRIVATE_STATE_ID = "tttChannel";

export interface DeployOpts {
  args: DeployArgs;
  seed?: string;
  initialPrivateState: TicTacToePrivateState;
  privateStateStoreName?: string;
  privateStateId?: string;
  midnightDbName?: string;
  /** Optional pre-built wallet — pass to avoid the 30-60 s sync cost. */
  wallet?: WalletBundle;
}

function makeCompiled() {
  return CompiledContract.make("tictactoe-channel", Contract as any).pipe(
    CompiledContract.withWitnesses(createWitnesses() as never),
    CompiledContract.withCompiledFileAssets(ARTIFACTS_DIR),
  );
}

export async function deployTicTacToe(opts: DeployOpts): Promise<DeploymentResult> {
  setNetworkId(NETWORK.networkId);
  const wallet = opts.wallet ?? await buildAndFundWallet(NETWORK, opts.seed ?? requiredSeed());

  const providers = buildProviders({
    wallet,
    zkConfigPath: ARTIFACTS_DIR,
    privateStateStoreName: opts.privateStateStoreName ?? "ttt-private-state-deploy",
    networkUrls: NETWORK,
    midnightDbName: opts.midnightDbName ?? "tictactoe-level-db-deploy",
  });

  log.info(`Deploying TicTacToeChannel (artifacts: ${ARTIFACTS_DIR})…`);
  const compiledContract = makeCompiled();

  const deployed = await deployContract(providers as any, {
    compiledContract: compiledContract as any,
    privateStateId: (opts.privateStateId ?? DEFAULT_PRIVATE_STATE_ID) as any,
    initialPrivateState: opts.initialPrivateState as any,
    args: [opts.args.idX, opts.args.rootX],
  } as any);

  const contractAddress = (deployed as any).deployTxData.public.contractAddress;
  log.info(`Deployed at ${contractAddress}`);

  await writeFile(DEPLOYMENT_FILE, JSON.stringify({ contractAddress }, null, 2));
  return { contractAddress, wallet, providers };
}

export interface AttachOpts {
  contractAddress: string;
  seed?: string;
  initialPrivateState: TicTacToePrivateState;
  privateStateStoreName?: string;
  privateStateId?: string;
  midnightDbName?: string;
  wallet?: WalletBundle;
}

export async function attachTicTacToe(opts: AttachOpts) {
  setNetworkId(NETWORK.networkId);
  const wallet = opts.wallet ?? await buildAndFundWallet(NETWORK, opts.seed ?? requiredSeed());

  const providers = buildProviders({
    wallet,
    zkConfigPath: ARTIFACTS_DIR,
    privateStateStoreName:
      opts.privateStateStoreName ?? `ttt-private-state-${opts.contractAddress.slice(2, 12)}`,
    networkUrls: NETWORK,
    midnightDbName:
      opts.midnightDbName ?? `tictactoe-level-db-${opts.contractAddress.slice(2, 12)}`,
  });

  const compiledContract = makeCompiled();
  const found = await findDeployedContract(providers as any, {
    contractAddress: opts.contractAddress as any,
    compiledContract: compiledContract as any,
    privateStateId: (opts.privateStateId ?? DEFAULT_PRIVATE_STATE_ID) as any,
    initialPrivateState: opts.initialPrivateState as any,
  } as any);

  return { found, providers, wallet };
}

// Phase-2 open: O's client calls this AFTER X has deployed the channel.
// `idO` and `rootO` come from O's own browser; the relay just submits the
// tx on behalf of the wallet.
export async function joinChannelCall(opts: {
  contractAddress: string;
  joinArgs: JoinArgs;
  wallet: WalletBundle;
}) {
  const { found } = await attachTicTacToe({
    contractAddress: opts.contractAddress,
    wallet: opts.wallet,
    initialPrivateState: createTicTacToePrivateState(new Uint8Array(32)),
    privateStateStoreName: `ttt-relay-join-${opts.contractAddress.slice(2, 12)}`,
    midnightDbName: `tictactoe-relay-db-join-${opts.contractAddress.slice(2, 12)}`,
  });
  const tx = await (found as any).callTx.joinChannel(opts.joinArgs.idO, opts.joinArgs.rootO);
  return { txId: tx.public.txId as string };
}

// Read the on-chain ledger for the deployed contract — handy for asserting
// `winner` / `status` in tests without a circuit call.
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

function requiredSeed(): string {
  return (
    process.env.MIDNIGHT_WALLET_SEED ||
    "0000000000000000000000000000000000000000000000000000000000000001"
  );
}

// Ensure the deploy file's parent dir exists if a custom path was set.
{
  const dir = path.dirname(DEPLOYMENT_FILE);
  if (dir && dir !== "." && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}
