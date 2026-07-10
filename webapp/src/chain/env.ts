// Browser-side network config, baked into the bundle at build time from
// VITE_* variables. This replaces src/sdk/env.ts inside the webapp: that file
// reads process.env, which is an empty polyfill in the browser, so a deployed
// bundle would silently fall back to the localhost dev stack.
//
// One shared .env at the repo root (vite.config.ts sets envDir: "..") can hold
// the endpoints + arena address for EVERY network, suffixed per network id;
// VITE_NETWORK_ID selects which row a build targets:
//
//   VITE_NETWORK_ID=preview
//   VITE_ARENA_ADDRESS_PREVIEW=…   VITE_INDEXER_URL_PREVIEW=…   (etc.)
//   VITE_ARENA_ADDRESS_PREPROD=…   VITE_INDEXER_URL_PREPROD=…
//   VITE_ARENA_ADDRESS_MAINNET=…   VITE_INDEXER_URL_MAINNET=…
//
// Unsuffixed variables (VITE_ARENA_ADDRESS, VITE_INDEXER_URL, …) are generic
// fallbacks; a network-suffixed value always wins so a mainnet build can never
// silently pick up another network's row. With nothing set, everything
// defaults to the local `undeployed` stack (`bun run stack:up`).
//
// Vite statically replaces `import.meta.env.VITE_*` property accesses —
// dynamic keys are not substituted — so every supported variable is spelled
// out below.

import type { NetworkUrls } from "../../../src/sdk/env.ts";
import type { NetworkId } from "@midnight-ntwrk/wallet-sdk-abstractions";

export const NETWORK_ID: string =
  import.meta.env.VITE_NETWORK_ID?.trim() || "undeployed";

export const IS_UNDEPLOYED = NETWORK_ID === "undeployed";

type PerNetwork = Record<string, string | undefined>;

// Suffixed value for the active network wins; unsuffixed is the fallback.
function pick(byNetwork: PerNetwork, generic: string | undefined): string | undefined {
  return byNetwork[NETWORK_ID]?.trim() || generic?.trim() || undefined;
}

// A localhost default is only meaningful against the local dev stack; on a
// real network a missing endpoint is a build misconfiguration.
function endpoint(byNetwork: PerNetwork, generic: string | undefined, devDefault: string): string {
  const v = pick(byNetwork, generic);
  if (v) return v;
  if (IS_UNDEPLOYED) return devDefault;
  return ""; // caught by assertNetworkConfigured() before any chain call
}

export const INDEXER_URL = endpoint(
  {
    preview: import.meta.env.VITE_INDEXER_URL_PREVIEW,
    preprod: import.meta.env.VITE_INDEXER_URL_PREPROD,
    mainnet: import.meta.env.VITE_INDEXER_URL_MAINNET,
  },
  import.meta.env.VITE_INDEXER_URL,
  "http://127.0.0.1:8088/api/v3/graphql",
);

export const INDEXER_WS_URL = endpoint(
  {
    preview: import.meta.env.VITE_INDEXER_WS_URL_PREVIEW,
    preprod: import.meta.env.VITE_INDEXER_WS_URL_PREPROD,
    mainnet: import.meta.env.VITE_INDEXER_WS_URL_MAINNET,
  },
  import.meta.env.VITE_INDEXER_WS_URL,
  "ws://127.0.0.1:8088/api/v3/graphql/ws",
);

export const NODE_URL = endpoint(
  {
    preview: import.meta.env.VITE_NODE_URL_PREVIEW,
    preprod: import.meta.env.VITE_NODE_URL_PREPROD,
    mainnet: import.meta.env.VITE_NODE_URL_MAINNET,
  },
  import.meta.env.VITE_NODE_URL,
  "http://127.0.0.1:9944",
);

export const PROOF_SERVER_URL = endpoint(
  {
    preview: import.meta.env.VITE_PROOF_SERVER_URL_PREVIEW,
    preprod: import.meta.env.VITE_PROOF_SERVER_URL_PREPROD,
    mainnet: import.meta.env.VITE_PROOF_SERVER_URL_MAINNET,
  },
  import.meta.env.VITE_PROOF_SERVER_URL,
  "http://127.0.0.1:6300",
);

// The deployed NixNaxArena address for the active network. On `undeployed`
// this may be absent — arena.ts falls back to fetching /arena.json (written by
// `bun run deploy`). On any real network it is required.
export const ARENA_ADDRESS: string | undefined = pick(
  {
    undeployed: import.meta.env.VITE_ARENA_ADDRESS_UNDEPLOYED,
    preview: import.meta.env.VITE_ARENA_ADDRESS_PREVIEW,
    preprod: import.meta.env.VITE_ARENA_ADDRESS_PREPROD,
    mainnet: import.meta.env.VITE_ARENA_ADDRESS_MAINNET,
  },
  import.meta.env.VITE_ARENA_ADDRESS,
);

// Encrypts the local (per-browser) private-state store only — not a server
// secret, but overridable so builds don't all share the dev default.
export const STORAGE_PASSWORD: string =
  import.meta.env.VITE_STORAGE_PASSWORD?.trim() || "YourPasswordMy1!";

// Same shape src/sdk/env.ts exports, so the SDK wallet/provider helpers accept it.
export const NETWORK: NetworkUrls = {
  indexer: INDEXER_URL,
  indexerWS: INDEXER_WS_URL,
  node: NODE_URL,
  proofServer: PROOF_SERVER_URL,
  networkId: NETWORK_ID as NetworkId.NetworkId,
};

// Fail fast (with a message naming the missing vars) instead of letting a
// misconfigured non-dev build fetch against empty URLs. Called lazily from the
// chain layer so a bad build still renders the UI.
export function assertNetworkConfigured(): void {
  if (IS_UNDEPLOYED) return;
  const missing: string[] = [];
  if (!INDEXER_URL) missing.push("VITE_INDEXER_URL");
  if (!INDEXER_WS_URL) missing.push("VITE_INDEXER_WS_URL");
  if (!NODE_URL) missing.push("VITE_NODE_URL");
  if (!PROOF_SERVER_URL) missing.push("VITE_PROOF_SERVER_URL");
  if (missing.length) {
    throw new Error(
      `network "${NETWORK_ID}" build is missing ${missing
        .map((m) => `${m}(_${NETWORK_ID.toUpperCase()})`)
        .join(", ")} — set them in the root .env and rebuild`,
    );
  }
}
