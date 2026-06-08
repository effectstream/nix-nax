// Minimal CLI for manual testing — `bun run cli <cmd> [args]`.
//
// v1 surface is intentionally tiny: open a channel, show on-chain state,
// dispute via timeout, prove fraud. SignedMove exchange uses stdin/stdout
// JSON. Two players in two terminals can paste between each other.

import { openChannelTogether } from "../sdk/game/game-session.ts";
import { decodeMove, encodeMove, parseMove, stringifyMove } from "../sdk/game/messaging.ts";
import { attachTicTacToe, loadDeployedAddress, readLedger } from "../sdk/deploy.ts";
import { createTicTacToePrivateState } from "../contract/witnesses.ts";

const args = process.argv.slice(2);
const cmd = args.shift();

async function main() {
  switch (cmd) {
    case "open": {
      // Deploys a channel and prints both player keys + contract address.
      // Real usage would generate per-player keys separately and only share
      // commitments + roots — but for the demo it's fine to seed both here.
      const { x, o, contractAddress } = await openChannelTogether();
      console.log(JSON.stringify({
        contractAddress,
        xId: Buffer.from(x.keys.id).toString("hex"),
        oId: Buffer.from(o.keys.id).toString("hex"),
      }, null, 2));
      break;
    }
    case "show": {
      const addr = args[0] ?? await loadDeployedAddress();
      if (!addr) throw new Error("contract address missing — pass it or set MIDNIGHT_DEPLOYMENT_FILE");
      const { providers } = await attachTicTacToe({
        contractAddress: addr,
        initialPrivateState: createTicTacToePrivateState(new Uint8Array(32)),
      });
      const led = await readLedger(providers, addr);
      console.log(JSON.stringify({
        status: led.status,
        winner: led.winner,
        committedTurns: led.committedTurns.toString(),
        turnMark: led.turnMark.toString(),
        hasDeadline: led.hasDeadline,
        hasChallenge: led.hasChallenge,
      }, null, 2));
      break;
    }
    case "decode-move": {
      // Read move JSON from stdin and print structured info.
      const text = await readStdin();
      const m = parseMove(text);
      console.log(JSON.stringify({ channelId: m.channelId, turn: m.turn, cell: m.cell }, null, 2));
      break;
    }
    default:
      console.log(`tictactoe-compact CLI

usage:
  bun run cli open                 — deploy a fresh channel
  bun run cli show [address]       — read on-chain state
  bun run cli decode-move          — parse SignedMove JSON from stdin

For full e2e tests:  bun run test:e2e (after \`bun run stack:up\`).
`);
      process.exit(1);
  }
}

async function readStdin(): Promise<string> {
  let buf = "";
  for await (const chunk of process.stdin) buf += chunk;
  return buf;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
