// Permanent top-right wallet control (rendered at the App level, so it's on the
// lobby and in-game alike). No game backend: every tx is built + submitted in the
// browser (proofs come from a proof server), and gas is paid by an in-browser wallet (the genesis wallet by
// default). On the `undeployed` dev network, the modal offers a FAUCET that mints
// a session wallet, funds it with NIGHT from genesis, registers it for dust, and
// makes it the gas payer. Injected extension wallets (testnet) can also connect.

import { useEffect, useState } from "react";
import { connect, connectSessionWallet, disconnect, useWallet, isConnected, openWalletModal, closeWalletModal, listWallets, NETWORK_ID, type InitialAPI } from "../wallet/useWallet.ts";
import { runFaucet, restoreSessionWallet, hasStoredSessionWallet, fundConnectedWallet, type FaucetResult } from "../wallet/faucet.ts";
import { readWinBalance } from "../chain/arena.ts";

// Long bech32 addresses → short, readable form: first 10 … last 6.
const shortAddr = (a: string): string => (a.length <= 18 ? a : `${a.slice(0, 10)}…${a.slice(-6)}`);

export default function WalletButton() {
  const wallet = useWallet();
  const open = wallet.modalOpen;
  const [faucetRunning, setFaucetRunning] = useState(false);
  const [faucetLog, setFaucetLog] = useState<string[]>([]);
  const [session, setSession] = useState<FaucetResult | null>(null);
  const wallets = listWallets();
  const isLocal = NETWORK_ID === "undeployed";

  const connected = isConnected(wallet);

  // Win-token count for the connected wallet — read as soon as it connects,
  // re-read when the modal opens (e.g. right after a Redeem). Only when
  // connected: reading with no wallet would spin up the heavy local wallet.
  const [wins, setWins] = useState<number | null>(null);
  useEffect(() => {
    if (!connected) { setWins(null); return; }
    let live = true;
    void readWinBalance().then((n) => { if (live) setWins(n); }).catch(() => {});
    return () => { live = false; };
  }, [connected, wallet.address, open]);

  const label = session
    ? shortAddr(session.address)
    : wallet.address
      ? shortAddr(wallet.address)
      : connected
        ? (wallet.name ?? "Connected")
        : "Wallet";

  const pickWallet = async (w: InitialAPI) => { closeWalletModal(); await connect(w); };

  // Auto-restore the per-browser session wallet on load. Its seed is persisted,
  // so a reload should not cost the player another faucet click — and the
  // faucet only re-runs when the recovered wallet is genuinely unfunded (e.g.
  // the dev chain was wiped under it). Runs once, and never over an
  // extension wallet the player connected themselves.
  const [restoring, setRestoring] = useState(false);
  useEffect(() => {
    if (!isLocal || connected || !hasStoredSessionWallet()) return;
    let live = true;
    setRestoring(true);
    void restoreSessionWallet((s) => { if (live) setFaucetLog((l) => [...l.slice(-7), s]); })
      .then((r) => {
        if (!live || !r) return;
        setSession(r);
        connectSessionWallet(r.address);
      })
      .catch((e) => { if (live) setFaucetLog((l) => [...l, "❌ " + (e as Error).message]); })
      .finally(() => { if (live) setRestoring(false); });
    return () => { live = false; };
    // Mount-only: the guards above (connected / stored seed) decide whether it runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doFaucet = () => {
    setFaucetRunning(true);
    setFaucetLog([]);
    void (async () => {
      try {
        const r = await runFaucet((s) => setFaucetLog((l) => [...l.slice(-7), s]));
        setSession(r);
        connectSessionWallet(r.address);
      } catch (e) {
        setFaucetLog((l) => [...l, "❌ " + (e as Error).message]);
      } finally {
        setFaucetRunning(false);
      }
    })();
  };

  // Dev-chain faucet for a CONNECTED extension wallet (e.g. Lace on
  // undeployed): sends NIGHT from genesis to its address. First run brings up
  // the genesis wallet (~30s sync).
  const [extFunding, setExtFunding] = useState(false);
  const doFundConnected = () => {
    if (!wallet.address) return;
    setExtFunding(true);
    setFaucetLog([]);
    void (async () => {
      try {
        await fundConnectedWallet(wallet.address!, (s) => setFaucetLog((l) => [...l.slice(-7), s]));
      } catch (e) {
        setFaucetLog((l) => [...l, "❌ " + (e as Error).message]);
      } finally {
        setExtFunding(false);
      }
    })();
  };

  return (
    <>
      <button
        className={`wallet-btn glass ${connected ? "connected wallet" : ""}`}
        onClick={openWalletModal}
        title={session?.address ?? wallet.address ?? undefined}
      >
        <span className={`wallet-dot ${connected ? "wallet" : "off"}`} />
        <span className="wallet-label">{label}</span>
        {wins !== null && (
          <span className="wallet-wins" title="Your NixNax wins (shielded win-tokens)">🏆 {wins}</span>
        )}
      </button>

      {open && (
        <div className="modal-overlay" onClick={closeWalletModal}>
          <div className="modal-card glass wallet-modal" onClick={(e) => e.stopPropagation()}>
            <h2 className="modal-title">Wallet</h2>
            <p className="muted" style={{ marginTop: 0 }}>
              Transactions are built and submitted by your browser, and gas is paid by an
              in-browser wallet — there is no game backend. Zero-knowledge proofs are generated
              by a <strong>proof server</strong> (your wallet's, or the one this build points at),
              which never sees your keys.
            </p>

            {connected ? (
              /* ── Connected: show THE connection, not more connect options ── */
              <div className="col" style={{ marginTop: 4 }}>
                <div className="wallet-row static">
                  <span className="wallet-dot wallet" />
                  <span className="name">
                    {wallet.mode === "local" ? "Session Wallet + Auto Faucet" : (wallet.name ?? "Connected wallet")}
                  </span>
                  <span className="pay">pays gas</span>
                </div>
                {(wallet.address ?? session?.address) && (
                  <p className="wallet-addr-full mono">{wallet.address ?? session?.address}</p>
                )}
                {wallet.mode === "local" && session && (
                  <p className="muted" style={{ margin: 0 }}>dust {String(session.dust)}</p>
                )}
                {wallet.mode === "wallet" && wallet.dust && (
                  <p className="muted" style={{ margin: 0 }}>dust {String(wallet.dust.balance)}</p>
                )}

                {isLocal && wallet.mode === "wallet" && wallet.address && (
                  <>
                    <button className="btn-glass btn-block" onClick={doFundConnected} disabled={extFunding}>
                      {extFunding ? "Funding…" : `🚰 Faucet — fund ${shortAddr(wallet.address)} with NIGHT`}
                    </button>
                    <p className="muted" style={{ margin: "2px 2px 0" }}>
                      Dev-chain faucet: sends NIGHT from the genesis wallet. Register it for dust
                      (gas) from your wallet's own UI — dust delegation stays under the wallet's
                      control. CLI: <span className="mono">bun run faucet -- &lt;your-address&gt;</span>
                    </p>
                  </>
                )}

                {faucetLog.length > 0 && <pre className="faucet-log">{faucetLog.join("\n")}</pre>}

                <button className="btn-glass btn-block" onClick={() => { setSession(null); disconnect(); }}>
                  Disconnect
                </button>
              </div>
            ) : (
              /* ── Not connected: the connect options ── */
              <>
                {isLocal && (
                  <div className="col" style={{ marginTop: 4 }}>
                    <button className="btn-glass btn-block" onClick={doFaucet} disabled={faucetRunning || restoring}>
                      {restoring
                        ? "Reconnecting this browser's wallet…"
                        : faucetRunning
                          ? "Connecting…"
                          : hasStoredSessionWallet()
                            ? "🚰 Reconnect this browser's wallet"
                            : "🚰 Session Wallet + Auto Faucet"}
                    </button>
                    {faucetLog.length > 0 && <pre className="faucet-log">{faucetLog.join("\n")}</pre>}
                  </div>
                )}

                {wallets.length > 0 && (
                  <div className="wallet-list" style={{ marginTop: 12 }}>
                    {wallets.map((w) => (
                      <button key={w.rdns} className="wallet-row" onClick={() => pickWallet(w)}>
                        {w.icon ? <img src={w.icon} alt="" className="wallet-icon" /> : <span className="wallet-icon ph" />}
                        <span className="name">{w.name}</span>
                        <span className="pay">you pay gas</span>
                      </button>
                    ))}
                    {isLocal && (
                      <p className="muted" style={{ margin: "6px 2px 0" }}>
                        External wallets must be set to <strong>{NETWORK_ID}</strong>. After connecting,
                        a <strong>Faucet</strong> button appears to fund them with dev-chain NIGHT.
                      </p>
                    )}
                  </div>
                )}
              </>
            )}

            <p className="wallet-net-note">
              Network: <strong>{NETWORK_ID}</strong>
              {wins !== null && <> · Wins: <strong>🏆 {wins}</strong></>}
            </p>
          </div>
        </div>
      )}
    </>
  );
}
