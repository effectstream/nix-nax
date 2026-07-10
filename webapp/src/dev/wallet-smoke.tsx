// DE-RISK smoke (#wallet-dev): proves the WHOLE client-side chain path works in
// the browser against the local undeployed stack —
//   1. the full @midnight-ntwrk WalletFacade syncs + funds (Risk #1),
//   2. browser providers (FetchZkConfig over HTTP + http proof + indexer + level),
//   3. attach the deployed arena + submit a real createGame (prove + balance +
//      submit, all client-side).
// If this reaches "createGame tx <id>", the serverless migration is fully de-risked.
// Throwaway harness.

import { useEffect, useRef, useState } from "react";
import { findDeployedContract } from "@midnight-ntwrk/midnight-js-contracts";
import { NETWORK } from "../chain/env.ts";
import { buildAndFundWallet, waitForFunds } from "../../../src/sdk/wallet.ts";
import { createTicTacToePrivateState } from "../../../src/contract/index.ts";
import { generatePlayerKeys } from "../game/player-session.ts";
import { buildBrowserProviders } from "../chain/providers.ts";
import { makeCompiled, PRIVATE_STATE_ID } from "../chain/compiled.ts";

const GENESIS = "0000000000000000000000000000000000000000000000000000000000000001";
const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");

export default function WalletSmoke() {
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
        push("1/5 building + funding the genesis wallet in-browser…");
        const wallet = await buildAndFundWallet(NETWORK, GENESIS);
        const funds = await waitForFunds(wallet, { requireShielded: false });
        push(`    ✅ funded: unshielded=${funds.unshielded} dust=${funds.dust} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);

        push("2/5 reading arena.json…");
        const arena = await (await fetch("/arena.json")).json();
        push(`    ✅ arena ${arena.contractAddress.slice(0, 16)}…`);

        push("3/5 building browser providers (FetchZkConfig + proof + indexer)…");
        const providers = buildBrowserProviders({ wallet });
        push("    ✅ providers built");

        push("4/5 attaching the deployed arena (loads compiled assets over HTTP)…");
        const found: any = await findDeployedContract(providers as any, {
          contractAddress: arena.contractAddress,
          compiledContract: makeCompiled() as any,
          privateStateId: PRIVATE_STATE_ID as any,
          initialPrivateState: createTicTacToePrivateState(new Uint8Array(32)) as any,
        } as any);
        push("    ✅ attached — callTx ready");

        push("5/5 generating player commitments + submitting createGame…");
        const gidBytes = crypto.getRandomValues(new Uint8Array(32));
        const keys = generatePlayerKeys("x", gidBytes);
        push(`    gameId ${hex(gidBytes).slice(0, 16)}… — proving + balancing + submitting…`);
        const tx = await found.callTx.createGame(
          gidBytes,
          keys.id,
          { field: keys.tokenTree.root.field },
          { field: keys.indexTree.root.field },
          { field: keys.randomTree.root.field },
        );
        push(`    ✅ createGame tx ${String(tx.public.txId).slice(0, 24)}…`);
        push(`🎉 FULLY client-side createGame landed in ${((Date.now() - t0) / 1000).toFixed(0)}s — serverless path proven.`);
      } catch (e) {
        push("❌ " + (e as Error).message);
        // eslint-disable-next-line no-console
        console.error("[wallet-smoke]", e);
      }
    })();
  }, []);

  return (
    <pre style={{ padding: 24, margin: 0, minHeight: "100vh", background: "#05070e", color: "#e7eef8", fontSize: 13, lineHeight: 1.7, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
      {"— client-side chain smoke (#wallet-dev) —\n\n" + lines.join("\n")}
    </pre>
  );
}
