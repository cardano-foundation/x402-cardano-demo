import type { WalletInfo } from "../lib/cip30";
import type { PaymentMethod } from "../x402/flow";
import { WalletPicker, type WalletConnection } from "./WalletPicker";
import { MethodPicker, type DemoMethod } from "./MethodPicker";
import { SettlementOptions, type ConfirmationRange } from "./SettlementOptions";

export type RunState = "idle" | "running" | "done" | "error" | "uncertain";

interface ControlPanelProps {
  wallets: WalletInfo[];
  connecting: string | null;
  connection: WalletConnection | null;
  connectError: string | null;
  onSelectWallet: (key: string) => void;
  methods: DemoMethod[];
  method: PaymentMethod | null;
  onMethodChange: (method: PaymentMethod) => void;
  runState: RunState;
  onBegin: () => void;
  onResume: () => void;
  onReset: () => void;
  l1Confirmations: number | null;
  confirmationRange: ConfirmationRange | null;
  onConfirmationsChange: (next: number) => void;
  configLoading: boolean;
  configError: string | null;
  onRetryConfig: () => void;
  settlementSyncing?: boolean;
  settlementError?: string | null;
  uncertainMessage?: string;
  uncertainTransaction?: string;
}

/** Connect a wallet, then run the protocol. The one place on the page that
 * asks the visitor to do something. */
export function ControlPanel({
  wallets,
  connecting,
  connection,
  connectError,
  onSelectWallet,
  methods,
  method,
  onMethodChange,
  runState,
  onBegin,
  onResume,
  onReset,
  l1Confirmations,
  confirmationRange,
  onConfirmationsChange,
  configLoading,
  configError,
  onRetryConfig,
  settlementSyncing,
  settlementError,
  uncertainMessage,
  uncertainTransaction,
}: ControlPanelProps) {
  const locked = runState === "running" || runState === "uncertain";
  const selected = methods.find((option) => option.id === method);
  const advancedSelected = selected && selected.id !== "default";

  return (
    <section className="control-panel" aria-label="Connect a wallet and run the protocol">
      <div className="control-panel__step">
        <span className="control-panel__step-label mono-tag">Step A</span>
        <h2>Connect a wallet</h2>
        <WalletPicker
          wallets={wallets}
          connecting={connecting}
          connection={connection}
          connectError={connectError}
          onSelect={onSelectWallet}
          disabled={locked}
        />
      </div>

      <div className="control-panel__divider" aria-hidden="true" />

      <div className="control-panel__step">
        <span className="control-panel__step-label mono-tag">Step B</span>
        <h2>Run the protocol</h2>

        {configLoading && (
          <p className="control-panel__hint" role="status">
            Loading payment terms from the server…
          </p>
        )}

        {configError && (
          <div className="config-error" role="alert">
            <p>Payment terms are unavailable: {configError}</p>
            <button type="button" className="btn btn--ghost" onClick={onRetryConfig}>
              Retry
            </button>
          </div>
        )}

        {selected && l1Confirmations !== null && confirmationRange && (
          <>
            <div className="payment-summary">
              <span>
                <span className="payment-summary__label">
                  {selected.label}
                  {selected.id === "default" && <span className="payment-summary__default">Default</span>}
                </span>
                <span className="payment-summary__meta">Cardano preprod · facilitator submits</span>
              </span>
              <strong className="payment-summary__price">{selected.price}</strong>
            </div>
            <p className="control-panel__hint">{methodHint(selected)}</p>

            <details className="advanced-options">
              <summary>
                <span>Advanced</span>
                <span className="advanced-options__selection">
                  {advancedSelected
                    ? `${selected.label} · ${selected.price}`
                    : `${l1Confirmations} confirmation${l1Confirmations === 1 ? "" : "s"}`}
                </span>
              </summary>
              <div className="advanced-options__body">
                <MethodPicker
                  methods={methods}
                  method={selected.id}
                  onChange={onMethodChange}
                  disabled={locked}
                />
                <SettlementOptions
                  value={l1Confirmations}
                  range={confirmationRange}
                  onChange={onConfirmationsChange}
                  disabled={locked}
                  syncing={settlementSyncing}
                  syncError={settlementError}
                />
              </div>
            </details>

            {runState === "uncertain" && (
              <div className="uncertain-payment" role="status">
                <p className="uncertain-payment__title">Settlement needs another check</p>
                <p>{uncertainMessage ?? "The payment may still settle. Check the same signed payment again."}</p>
                {uncertainTransaction && (
                  <p className="mono-tag" title={uncertainTransaction}>
                    Transaction {uncertainTransaction}
                  </p>
                )}
              </div>
            )}

            {runState === "uncertain" ? (
              <button type="button" className="btn btn--primary" onClick={onResume}>
                Check this payment again
              </button>
            ) : runState === "done" || runState === "error" ? (
              <button type="button" className="btn btn--ghost" onClick={onReset}>
                Start a new payment
              </button>
            ) : (
              <button
                type="button"
                className="btn btn--primary"
                onClick={onBegin}
                disabled={!connection || runState === "running" || settlementSyncing}
              >
                {runState === "running" ? "Payment in progress…" : methodAction(selected)}
              </button>
            )}
            {!connection && (
              <p className="control-panel__hint control-panel__hint--muted">Connect a preprod wallet first.</p>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function methodHint(method: DemoMethod): string {
  const token = method.asset.toLowerCase() !== "lovelace";
  const masumi = method.id === "masumi" || method.id === "masumi-usdm";

  if (masumi) {
    const tokenFunding = token
      ? " Your wallet also needs test ADA for the fee and the escrow output's minimum ADA."
      : "";
    return `${method.price} is locked in Masumi escrow, not delivered to the seller.${tokenFunding} This demo has no release or refund controls, and its x402 authorization is not compatible with the stock Masumi Payment Service.`;
  }
  if (token) {
    return `${method.price} is paid as a Cardano native token. Your wallet also needs test ADA for the transaction fee and the token output's minimum ADA.`;
  }
  return `${method.price} is paid directly after you approve the transaction signature. Your wallet does not broadcast it.`;
}

function methodAction(method: DemoMethod): string {
  return method.id === "masumi" || method.id === "masumi-usdm"
    ? `Lock ${method.price} in escrow`
    : `Pay ${method.price}`;
}
