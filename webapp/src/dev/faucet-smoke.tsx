// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

// Faucet smoke (#faucet-dev): exercises runFaucet in isolation — genesis → session
// NIGHT transfer + dust registration — to confirm a fresh session wallet can
// bootstrap dust on the local chain. Throwaway harness.

import { useEffect, useRef, useState } from "react";
import { runFaucet } from "../wallet/faucet.ts";

export default function FaucetSmoke() {
  const [lines, setLines] = useState<string[]>([]);
  const ran = useRef(false);
  const push = (s: string) =>
    setLines((l) => [...l, `${new Date().toISOString().slice(11, 19)}  ${s}`]);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    (async () => {
      const t0 = Date.now();
      try {
        const r = await runFaucet(push);
        push(`✅ done in ${((Date.now() - t0) / 1000).toFixed(0)}s — ${r.address.slice(0, 28)}… unshielded=${r.unshielded} dust=${r.dust} (alreadyFunded=${r.alreadyFunded})`);
      } catch (e) {
        push("❌ " + (e as Error).message);
        // eslint-disable-next-line no-console
        console.error("[faucet-smoke]", e);
      }
    })();
  }, []);

  return (
    <pre style={{ padding: 24, margin: 0, minHeight: "100vh", background: "#05070e", color: "#e7eef8", fontSize: 13, lineHeight: 1.7, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
      {"— faucet smoke (#faucet-dev) —\n\n" + lines.join("\n")}
    </pre>
  );
}
