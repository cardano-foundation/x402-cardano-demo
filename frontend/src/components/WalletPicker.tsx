import type { WalletInfo } from "../lib/cip30";
import { shortenMiddle } from "../lib/format";

export interface WalletConnection {
  key: string;
  address: string;
  networkId: number;
}

interface WalletPickerProps {
  wallets: WalletInfo[];
  connecting: string | null;
  connection: WalletConnection | null;
  connectError: string | null;
  onSelect: (key: string) => void;
  disabled?: boolean;
}

export function WalletPicker({ wallets, connecting, connection, connectError, onSelect, disabled }: WalletPickerProps) {
  if (connection) {
    return (
      <div className="wallet-connected">
        <div className="wallet-connected__identity">
          <span className="wallet-connected__dot" aria-hidden="true" />
          <span className="mono-tag wallet-connected__address" title={connection.address}>
            {shortenMiddle(connection.address)}
          </span>
        </div>
        <span className="wallet-connected__network">
          Testnet wallet
        </span>
        <button type="button" className="btn btn--ghost" onClick={() => onSelect(connection.key)} disabled={disabled || connecting !== null}>
          Reconnect wallet
        </button>
        <p className="wallet-connected__note">
          Live inputs are checked against preprod before signing.
        </p>
      </div>
    );
  }

  if (wallets.length === 0) {
    return (
      <div className="wallet-empty">
        <p>
          No CIP-30 wallet found in this browser. Install{" "}
          <a href="https://eternl.io/" target="_blank" rel="noreferrer">
            Eternl
          </a>{" "}
          or{" "}
          <a href="https://www.lace.io/" target="_blank" rel="noreferrer">
            Lace
          </a>
          , switch it to <strong>Preprod</strong>, and reload this page.
        </p>
      </div>
    );
  }

  return (
    <div className="wallet-picker">
      <ul className="wallet-picker__list">
        {wallets.map((wallet) => (
          <li key={wallet.key}>
            <button
              type="button"
              className="wallet-option"
              onClick={() => onSelect(wallet.key)}
              disabled={disabled || connecting !== null}
              aria-busy={connecting === wallet.key}
            >
              {wallet.icon ? (
                <img src={wallet.icon} alt="" className="wallet-option__icon" />
              ) : (
                <span className="wallet-option__icon wallet-option__icon--fallback" aria-hidden="true" />
              )}
              <span className="wallet-option__name">{wallet.name}</span>
              <span className="wallet-option__action">{connecting === wallet.key ? "Connecting…" : "Connect"}</span>
            </button>
          </li>
        ))}
      </ul>
      {connectError && <p className="wallet-picker__error" role="alert">{connectError}</p>}
    </div>
  );
}
