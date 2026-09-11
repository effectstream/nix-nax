// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

// Permanent top-right wallet control. Wallet selection, restoration and funding
// orchestration live in useWalletController; this component renders the control.

import { useWalletController } from "./hooks/useWalletController.ts";

// Long bech32 addresses → short, readable form: first 10 … last 6.
const shortAddr = (a: string): string => (a.length <= 18 ? a : `${a.slice(0, 10)}…${a.slice(-6)}`);

export default function WalletButton() {
  const {
    wallet, open, faucetRunning, extFunding, restoring, faucetLog, session, wallets,
    isLocal, connected, wins, pickWallet, doDisconnect, doFaucet, doFundConnected,
    openWalletModal, closeWalletModal, hasStoredSessionWallet, NETWORK_ID,
  } = useWalletController();

  const label = session
    ? shortAddr(session.address)
    : wallet.address
      ? shortAddr(wallet.address)
      : connected
        ? (wallet.name ?? "Connected")
        : "Wallet";

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
              by a <strong>proof server</strong> (your wallet's, or the one this build points at).
              The prover receives the circuit's private witness inputs, but not your extension wallet's
              seed or spending keys. Use a prover you trust, or run one locally.
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

                <button
                  className="btn-glass btn-block"
                  onClick={doDisconnect}
                  title="Stop using this wallet and forget the choice — nothing reconnects on the next load"
                >
                  Disconnect{wallet.mode === "local" ? " (keeps the funded wallet for later)" : ""}
                </button>

                {/* Switching wallets while connected: the extension list stays
                    reachable so a player on the session wallet can hand over to
                    Lace without disconnecting first. */}
                {wallets.length > 0 && (
                  <div className="wallet-list" style={{ marginTop: 6 }}>
                    {wallets.map((w) => (
                      <button key={w.rdns} className="wallet-row" onClick={() => pickWallet(w)}>
                        {w.icon ? <img src={w.icon} alt="" className="wallet-icon" /> : <span className="wallet-icon ph" />}
                        <span className="name">Switch to {w.name}</span>
                        <span className="pay">you pay gas</span>
                      </button>
                    ))}
                  </div>
                )}
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
