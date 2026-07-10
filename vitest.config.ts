import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // One worker, threads pool: the compiled-contract WASM initialises once and
    // is reused across tests, and thread-based messaging doesn't starve the
    // reporter heartbeat the way the forks-pool IPC does under long synchronous
    // circuit computation (which triggered "Timeout calling onTaskUpdate" once
    // the suite grew past ~80 heavy tests).
    pool: "threads",
    poolOptions: {
      threads: { singleThread: true },
    },
  },
});
