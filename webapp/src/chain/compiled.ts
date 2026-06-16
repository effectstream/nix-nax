// Browser build of the GobbletArena compiled contract. Mirrors makeCompiled()
// in src/sdk/deploy.ts, but `withCompiledFileAssets` points at the HTTP path the
// vite dev middleware serves (src/contract/managed) instead of a filesystem dir —
// compact-js fetches the assets over HTTP in the browser.

import { CompiledContract } from "@midnight-ntwrk/compact-js";
import { Contract, createWitnesses } from "../../../src/contract/index.ts";

// Served by the `serve-contract-assets` vite plugin (see webapp/vite.config.ts).
export const ZK_ASSETS_BASE = "/contract/compiled/gobblet-arena";
export const CONTRACT_NAME = "gobblet-arena";
export const PRIVATE_STATE_ID = "tttChannel";

export function makeCompiled() {
  return CompiledContract.make(CONTRACT_NAME, Contract as any).pipe(
    CompiledContract.withWitnesses(createWitnesses() as never),
    CompiledContract.withCompiledFileAssets(ZK_ASSETS_BASE),
  );
}
