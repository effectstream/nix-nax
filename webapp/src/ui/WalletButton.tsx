// Permanent top-right wallet control (rendered at the App level, so it's on the
// lobby and in-game alike). Disconnected: a "Connect wallet" pill that opens a
// modal listing the injected Midnight wallets — plus a "Local wallet" option on
// the undeployed dev network (relay pays gas). Connected: shows the wallet's
// address in short human-readable form; the modal then offers Disconnect.

import { useState } from "react";
import {
  connect,
  connectLocal,
  disconnect,
  useWallet,
  listWallets,
  NETWORK_ID,
  type InitialAPI,
} from "../wallet/useWallet.ts";

// Long bech32 addresses → short, readable form: first 10 … last 6.
const shortAddr = (a: string): string => (a.length <= 18 ? a : `${a.slice(0, 10)}…${a.slice(-6)}`);

export default function WalletButton() {
  const wallet = useWallet();
  const [open, setOpen] = useState(false);
  const wallets = listWallets();
  const showLocal = NETWORK_ID === "undeployed";

  const label = wallet.connecting
    ? "Connecting…"
    : wallet.mode === "wallet"
      ? wallet.address ? shortAddr(wallet.address) : (wallet.name ?? "Connected")
      : wallet.mode === "local"
        ? "Local wallet"
        : "Connect wallet";

  const pickWallet = async (w: InitialAPI) => { setOpen(false); await connect(w); };
  const pickLocal = () => { setOpen(false); connectLocal(); };

  return (
    <>
      <button
        className={`wallet-btn glass ${wallet.mode ? `connected ${wallet.mode}` : ""}`}
        onClick={() => setOpen(true)}
        disabled={wallet.connecting}
        title={wallet.address ?? undefined}
      >
        <span className={`wallet-dot ${wallet.mode ?? "off"}`} />
        <span className="wallet-label">{label}</span>
      </button>

      {open && (
        <div className="modal-overlay" onClick={() => setOpen(false)}>
          <div className="modal-card glass wallet-modal" onClick={(e) => e.stopPropagation()}>
            <h2 className="modal-title">{wallet.mode ? "Wallet" : "Connect a wallet"}</h2>

            {wallet.mode ? (
              <div className="col">
                <div className="wallet-row static">
                  <span className={`wallet-dot ${wallet.mode}`} />
                  <span className="name">{wallet.name}</span>
                  <span className="pay">{wallet.mode === "wallet" ? "you pay gas" : "relay pays gas"}</span>
                </div>
                {wallet.address && <p className="wallet-addr-full mono">{wallet.address}</p>}
                {wallet.dust && <p className="muted" style={{ margin: 0 }}>dust {String(wallet.dust.balance)} / {String(wallet.dust.cap)}</p>}
                <button className="btn-glass btn-block" onClick={() => { setOpen(false); disconnect(); }}>Disconnect</button>
              </div>
            ) : (
              <div className="wallet-list">
                {wallets.map((w) => (
                  <button key={w.rdns} className="wallet-row" onClick={() => pickWallet(w)}>
                    {w.icon ? <img src={w.icon} alt="" className="wallet-icon" /> : <span className="wallet-icon ph" />}
                    <span className="name">{w.name}</span>
                    <span className="pay">you pay gas</span>
                  </button>
                ))}
                {showLocal && (
                  <button className="wallet-row" onClick={pickLocal}>
                    <span className="wallet-icon ph">🖥️</span>
                    <span className="name">Local wallet</span>
                    <span className="pay">relay pays gas</span>
                  </button>
                )}
                {wallets.length === 0 && !showLocal && (
                  <p className="muted" style={{ textAlign: "center" }}>No Midnight wallet extension detected.</p>
                )}
              </div>
            )}

            <p className="wallet-net-note">
              Your wallet must be on the <strong>{NETWORK_ID}</strong> network.
            </p>
          </div>
        </div>
      )}
    </>
  );
}
