// Permanent top-right wallet control (rendered at the App level, so it's on the
// lobby and in-game alike). Post-serverless: every tx is built + submitted in the
// browser, and gas is paid by an in-browser wallet (the genesis wallet by
// default). On the `undeployed` dev network, the modal offers a FAUCET that mints
// a session wallet, funds it with NIGHT from genesis, registers it for dust, and
// makes it the gas payer. Injected extension wallets (testnet) can also connect.

import { useState } from "react";
import { connect, connectSessionWallet, useWallet, isConnected, openWalletModal, closeWalletModal, listWallets, NETWORK_ID, type InitialAPI } from "../wallet/useWallet.ts";
import { runFaucet, type FaucetResult } from "../wallet/faucet.ts";

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
  const label = session
    ? shortAddr(session.address)
    : wallet.address
      ? shortAddr(wallet.address)
      : connected
        ? (wallet.name ?? "Connected")
        : "Wallet";

  const pickWallet = async (w: InitialAPI) => { closeWalletModal(); await connect(w); };

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

  return (
    <>
      <button
        className={`wallet-btn glass ${connected ? "connected wallet" : ""}`}
        onClick={openWalletModal}
        title={session?.address ?? wallet.address ?? undefined}
      >
        <span className={`wallet-dot ${connected ? "wallet" : "off"}`} />
        <span className="wallet-label">{label}</span>
      </button>

      {open && (
        <div className="modal-overlay" onClick={closeWalletModal}>
          <div className="modal-card glass wallet-modal" onClick={(e) => e.stopPropagation()}>
            <h2 className="modal-title">Wallet</h2>
            <p className="muted" style={{ marginTop: 0 }}>
              Transactions are built, proven, and submitted in your browser — no server. Gas is
              paid by an in-browser wallet.
            </p>

            {isLocal && (
              <div className="col" style={{ marginTop: 4 }}>
                {session ? (
                  <>
                    <div className="wallet-row static">
                      <span className="wallet-dot wallet" />
                      <span className="name">Session Wallet + Auto Faucet</span>
                      <span className="pay">pays gas</span>
                    </div>
                    <p className="wallet-addr-full mono">{session.address}</p>
                    <p className="muted" style={{ margin: 0 }}>dust {String(session.dust)}</p>
                  </>
                ) : (
                  <button className="btn-glass btn-block" onClick={doFaucet} disabled={faucetRunning}>
                    {faucetRunning ? "Connecting…" : "🚰 Session Wallet + Auto Faucet"}
                  </button>
                )}
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
              </div>
            )}

            <p className="wallet-net-note">Network: <strong>{NETWORK_ID}</strong></p>
          </div>
        </div>
      )}
    </>
  );
}
