// Stop a previously-started local stack. Best-effort: reads PIDs from
// .stack-pids.json and SIGTERMs them. Also broadly cleans port-bound procs.

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import * as path from "node:path";

const PID_FILE = path.resolve(import.meta.dirname || ".", "..", ".stack-pids.json");

function killByPid(pid: number, name: string) {
  try {
    process.kill(pid, "SIGTERM");
    console.log(`[${name}] killed pid=${pid}`);
  } catch (e) {
    console.log(`[${name}] no pid=${pid}: ${(e as Error).message}`);
  }
}

function killByPort(port: number, name: string) {
  try {
    const out = execSync(`lsof -t -i :${port}`).toString().trim();
    if (!out) return;
    for (const pidStr of out.split(/\s+/)) {
      const pid = parseInt(pidStr, 10);
      if (Number.isFinite(pid)) killByPid(pid, `${name}:${port}`);
    }
  } catch {
    /* nothing on that port */
  }
}

if (existsSync(PID_FILE)) {
  const pids = JSON.parse(readFileSync(PID_FILE, "utf8")) as {
    node?: number; indexer?: number; proofServer?: number;
  };
  if (pids.node) killByPid(pids.node, "midnight-node");
  if (pids.indexer) killByPid(pids.indexer, "midnight-indexer");
  if (pids.proofServer) killByPid(pids.proofServer, "midnight-proof-server");
  unlinkSync(PID_FILE);
} else {
  console.log("(no .stack-pids.json — falling back to lsof port scan)");
}

killByPort(9944, "midnight-node");
killByPort(30333, "midnight-node");
killByPort(8088, "midnight-indexer");
killByPort(6300, "midnight-proof-server");
console.log("Stack down.");
