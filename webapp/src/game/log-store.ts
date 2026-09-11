// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

// Event log → browser console. The UI no longer renders a log panel; every
// `logEvent(msg)` call across the app prints a timestamped line to the JS
// console instead. The function name/signature is unchanged so all existing
// call sites keep working.

const ts = () => new Date().toISOString().slice(11, 19);

export function logEvent(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[ttt ${ts()}] ${msg}`);
}

// Version stamp injected by vite.config.ts `define` (git sha, "-dirty" when the
// working tree has changes) — proves which code the browser is actually running.
declare const __APP_VERSION__: string;
logEvent(`app loaded (${typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev"})`);
