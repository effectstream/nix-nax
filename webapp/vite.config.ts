import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { createReadStream, existsSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// The runtime/value-type packages must be a SINGLE instance: they define
// StateValue / ContractState / Transaction, which cross module boundaries and
// are checked with instanceof. compact-runtime can't be esbuild-optimized (WASM);
// if the others ARE optimized, esbuild inlines a 2nd copy of these classes →
// "expected instance of _StateValue". Excluding them keeps them external (raw)
// in EVERY bundle — optimized midnight-js-*/wallet-sdk-* import the same raw copy.
const RUNTIME_PKGS = [
  "@midnight-ntwrk/compact-runtime",
  "@midnight-ntwrk/onchain-runtime-v3",
  "@midnight-ntwrk/ledger-v8",
  "@midnight-ntwrk/zswap",
  "@midnight-ntwrk/compact-js",
];

// Serve the compiled contract assets (keys/zkir, ~77 MB) straight from
// src/contract/managed so the browser's CompiledContract (withCompiledFileAssets)
// and FetchZkConfigProvider can read them at /contract/compiled/nixnax-arena/* —
// no 77 MB copy into public/.
const MANAGED_DIR = fileURLToPath(new URL("../src/contract/managed", import.meta.url));
const ASSET_PREFIX = "/contract/compiled/nixnax-arena/";
function contractAssets(): Plugin {
  return {
    name: "serve-contract-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        if (!url.startsWith(ASSET_PREFIX)) return next();
        const rel = decodeURIComponent(url.slice(ASSET_PREFIX.length).split("?")[0]);
        const file = path.join(MANAGED_DIR, rel);
        if (!file.startsWith(MANAGED_DIR) || !existsSync(file) || !statSync(file).isFile()) {
          res.statusCode = 404;
          res.end("not found");
          return;
        }
        res.setHeader("content-type", "application/octet-stream");
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  // Read .env files from the repo root, so one shared .env holds both the
  // server-side MIDNIGHT_* vars and the browser VITE_* vars (see .env.example).
  envDir: "..",
  plugins: [
    react(),
    wasm(),
    topLevelAwait(),
    contractAssets(),
    nodePolyfills({
      globals: { Buffer: true, process: true, global: true },
      protocolImports: true,
      // The polyfills' transitive deps include CJS modules that vite can
      // mis-interop; restrict to the few we actually need. `crypto` is handled
      // by the alias below (crypto-browserify lacks timingSafeEqual).
      include: ["buffer", "process", "util", "events", "stream"],
    }),
  ],
  resolve: {
    // The runtime/ledger packages exist in BOTH webapp/ and root node_modules
    // (webapp imports ../../../src/* which resolves root's copies). Two instances
    // → ContractState fails cross-copy instanceof checks ("unexpected type").
    // Force a single instance of each.
    dedupe: [
      "@midnight-ntwrk/compact-runtime",
      "@midnight-ntwrk/onchain-runtime-v3",
      "@midnight-ntwrk/ledger-v8",
      "@midnight-ntwrk/zswap",
      "@midnight-ntwrk/compact-js",
    ],
    alias: {
      // midnight-js calls crypto.timingSafeEqual, missing from crypto-browserify.
      crypto: fileURLToPath(new URL("./src/chain/crypto-shim.ts", import.meta.url)),
      "node:crypto": fileURLToPath(new URL("./src/chain/crypto-shim.ts", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    fs: {
      // Allow importing the SDK from one level up (../src/...).
      allow: [".."],
    },
    proxy: {
      // Chain calls go direct to the indexer/node/proof server (CORS-open); only
      // the off-chain message relay is proxied now.
      "/relay": { target: "ws://localhost:4310", ws: true, changeOrigin: true },
    },
  },
  build: {
    // The chain layer needs top-level await (WASM runtime init); vite's default
    // es2020 target can't express it and the TLA plugin's lowering chokes on it.
    target: "esnext",
    // ledger/runtime WASM chunks are legitimately large; silence the 500k nag.
    chunkSizeWarningLimit: 4096,
  },
  optimizeDeps: {
    // Runtime/value-type packages stay raw → single instance (see above).
    exclude: RUNTIME_PKGS,
    // Force CJS interop for the few transitive deps that ship as CJS.
    include: ["object-inspect"],
  },
});
