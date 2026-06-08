import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  plugins: [
    react(),
    wasm(),
    topLevelAwait(),
    nodePolyfills({
      globals: { Buffer: true, process: true, global: true },
      protocolImports: true,
      // The polyfills' transitive deps include CJS modules that vite can
      // mis-interop; restrict to the few we actually need.
      include: ["buffer", "process", "util", "events", "stream", "crypto"],
    }),
  ],
  server: {
    port: 5173,
    fs: {
      // Allow importing the SDK from one level up (../src/...).
      allow: [".."],
    },
    proxy: {
      "/api":   { target: "http://localhost:4310", changeOrigin: true },
      "/relay": { target: "ws://localhost:4310", ws: true, changeOrigin: true },
    },
  },
  optimizeDeps: {
    exclude: ["@midnight-ntwrk/compact-runtime"],
    // Force CJS interop for the few transitive deps that ship as CJS.
    include: ["object-inspect"],
  },
});
