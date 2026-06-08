// Start the local Midnight stack: node + indexer + proof-server.
//
// Mirrors the `midnight-{node,indexer,proof-server}:start` scripts from
// pe-bun-3/e2e/shared/contracts/midnight/package.json. Backed by the public
// @effectstream/npm-midnight-* packages, which download and run the official
// Midnight binaries.
//
// PIDs are written to `.stack-pids.json` so `stack-down.ts` can kill them.

import { spawn } from "node:child_process";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname || ".");
const LOG_DIR = path.resolve(ROOT, "..", ".stack-logs");
const PID_FILE = path.resolve(ROOT, "..", ".stack-pids.json");

if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

const env = {
  ...process.env,
  MIDNIGHT_STORAGE_PASSWORD: process.env.MIDNIGHT_STORAGE_PASSWORD ?? "YourPasswordMy1!",
  CFG_PRESET: "dev",
};

function start(name: string, bin: string, args: string[], extraEnv: Record<string, string> = {}): number {
  const out = (msg: string) => console.log(`[${name}] ${msg}`);
  const logPath = path.resolve(LOG_DIR, `${name}.log`);
  out(`-> ${bin} ${args.join(" ")}  (logs: ${logPath})`);
  // Spawn detached so we can outlive bun; pipe stdout/stderr to the log file.
  const child = spawn(bin, args, {
    cwd: path.resolve(ROOT, ".."),
    env: { ...env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const fs = require("node:fs");
  const logStream = fs.createWriteStream(logPath, { flags: "a" });
  child.stdout?.pipe(logStream);
  child.stderr?.pipe(logStream);
  child.on("exit", (code, sig) => out(`exited code=${code} sig=${sig}`));
  child.on("error", (err) => out(`error: ${err.message}`));
  child.unref();
  return child.pid!;
}

const nodeArgs = [
  "node_modules/.bin/npm-midnight-node",
  "--dev",
  "--rpc-port", "9944",
  "--port", "30333",
  "--state-pruning", "archive",
  "--blocks-pruning", "archive",
  "--public-addr", "/ip4/127.0.0.1",
  "--unsafe-rpc-external",
];
const nodePid = start("midnight-node", "bun", nodeArgs);

const indexerEnv: Record<string, string> = {
  RUST_BACKTRACE: "1",
  LEDGER_NETWORK_ID: "Undeployed",
  SUBSTRATE_NODE_WS_URL: "ws://localhost:9944",
  FEATURES_WALLET_ENABLED: "true",
  APP__INFRA__NODE__URL: "ws://localhost:9944",
};
// Generate APP__INFRA__SECRET (must be hex uppercase 32 bytes).
const secret = Array.from({ length: 32 }, () =>
  Math.floor(Math.random() * 256).toString(16).toUpperCase().padStart(2, "0"),
).join("");
indexerEnv.APP__INFRA__SECRET = secret;

const indexerPid = start(
  "midnight-indexer",
  "bun",
  ["node_modules/.bin/npm-midnight-indexer", "--binary", "--clean"],
  indexerEnv,
);

const proofPid = start(
  "midnight-proof-server",
  "bun",
  ["node_modules/.bin/npm-midnight-proof-server"],
  { RUST_BACKTRACE: "full", SUBSTRATE_NODE_WS_URL: "ws://localhost:9944" },
);

writeFileSync(PID_FILE, JSON.stringify({ node: nodePid, indexer: indexerPid, proofServer: proofPid }, null, 2));
console.log(`PIDs written to ${PID_FILE}`);

// Wait for ports to come up.
const { spawn: spawnSync } = require("node:child_process");
const waitArgs = ["tcp:9944", "tcp:8088", "tcp:6300"];
console.log(`Waiting for ${waitArgs.join(", ")}…`);
const wait = spawnSync("bun", ["node_modules/.bin/wait-on", ...waitArgs, "--timeout", "180000"], { stdio: "inherit" });
wait.on("exit", (code: number) => {
  if (code === 0) console.log("Stack is up. Run `bun run test:e2e` next.");
  else {
    console.error(`wait-on failed with exit code ${code}. Check logs in ${LOG_DIR}.`);
    process.exit(code);
  }
});
