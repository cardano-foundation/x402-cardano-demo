import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { FlowStep } from "../x402/flow";
import type { StepCopy, StepId } from "../lib/stepCopy";
import {
  asPaymentPayload,
  asPaymentRequired,
  asSettledDetail,
  pickCardanoRequirements,
} from "../lib/x402Types";
import { ArtifactPanel } from "./ArtifactPanel";
import { base64ByteLength, explainErrorCode, findErrorCode, formatBytes, shortenMiddle } from "../lib/format";

export type StepStatus = "pending" | "active" | "done" | "error" | "paused";

const ACTIVE_MESSAGE: Partial<Record<StepId, string>> = {
  request: "Sending the unpaid request…",
  required: "Reading the price the server is asking for…",
  build: "Check your wallet — approve the payment transaction's signature.",
  pay: "Retrying the request with proof of payment attached…",
};

interface StepCardProps {
  index: number;
  id: StepId;
  copy: StepCopy;
  status: StepStatus;
  step?: FlowStep;
  error?: string;
  /** `maxTimeoutSeconds` from the `required` step's chosen requirements —
   * threaded in so the `build` card can show the TTL actually embedded in
   * the transaction, without flow.ts needing to repeat it. */
  maxTimeoutSeconds?: number;
  /** An extra, method-specific caption (currently only used to clarify what
   * "settled" means for the masumi escrow-lock route — see Timeline.tsx). */
  methodNote?: string;
  displayPrice: string;
}

export function StepCard({ index, id, copy, status, step, error, maxTimeoutSeconds, methodNote, displayPrice }: StepCardProps) {
  return (
    <li className="step-card" data-status={status} data-actor={copy.actor}>
      <div className="step-card__rail">
        <span className="step-card__index mono-tag">{String(index).padStart(2, "0")}</span>
        <span className="step-card__stem" aria-hidden="true" />
      </div>
      <div className="step-card__body">
        <header className="step-card__header">
          <h3 className="step-card__label">{copy.label}</h3>
          <StatusPill status={status} />
        </header>
        {step && <p className="step-card__wire mono-tag">{step.title}</p>}
        <p className="step-card__why">{copy.why}</p>
        {step && methodNote && <p className="step-note">{methodNote}</p>}

        {status === "active" && ACTIVE_MESSAGE[id] && (
          <p className="step-card__active-note">{ACTIVE_MESSAGE[id]}</p>
        )}

        {status === "error" && error && <ErrorNote message={error} />}

        {step && <StepArtifact step={step} maxTimeoutSeconds={maxTimeoutSeconds} displayPrice={displayPrice} />}
      </div>
    </li>
  );
}

function StatusPill({ status }: { status: StepStatus }) {
  const label = { pending: "Waiting", active: "In progress", done: "Done", error: "Failed", paused: "Check needed" }[status];
  return (
    <span className="status-pill" data-status={status}>
      <span className="status-pill__dot" aria-hidden="true" />
      {label}
    </span>
  );
}

function ErrorNote({ message }: { message: string }) {
  const code = findErrorCode(message);
  const explanation = code ? explainErrorCode(code) : undefined;
  return (
    <div className="error-note" role="alert">
      <p className="error-note__message">{message}</p>
      {explanation && <p className="error-note__explain">{explanation}</p>}
    </div>
  );
}

/** Dispatches to the per-step artifact renderer. Each `FlowStep.detail` has a
 * different real shape (see x402Types.ts) — this is where that gets decoded
 * into something a person can read. */
function StepArtifact({ step, maxTimeoutSeconds, displayPrice }: { step: FlowStep; maxTimeoutSeconds?: number; displayPrice: string }) {
  switch (step.id) {
    case "request":
      return <RequestArtifact detail={step.detail} />;
    case "required":
      return <RequiredArtifact detail={step.detail} displayPrice={displayPrice} />;
    case "build":
      return <BuildArtifact detail={step.detail} maxTimeoutSeconds={maxTimeoutSeconds} />;
    case "pay":
      return <PayArtifact detail={step.detail} displayPrice={displayPrice} />;
    case "settled":
      return <SettledArtifact detail={step.detail} />;
  }
}

function RequestArtifact({ detail }: { detail: { url: string; status: number } }) {
  return (
    <div className="artifact-summary">
      <dl className="spec-list">
        <div>
          <dt>Requested</dt>
          <dd className="mono-tag">{detail.url}</dd>
        </div>
        <div>
          <dt>Response</dt>
          <dd>
            <span className="status-code">HTTP {detail.status}</span>
          </dd>
        </div>
      </dl>
    </div>
  );
}

function RequiredArtifact({ detail, displayPrice }: { detail: unknown; displayPrice: string }) {
  const required = asPaymentRequired(detail);
  const accepted = pickCardanoRequirements(required);

  return (
    <div className="artifact-summary">
      {required.resource?.description && <p className="artifact-summary__lede">“{required.resource.description}”</p>}
      {accepted && (
        <dl className="spec-list">
          <div>
            <dt>Price</dt>
            <dd className="mono-tag mono-tag--accent">{displayPrice}</dd>
          </div>
          <div>
            <dt>Network</dt>
            <dd className="mono-tag">{accepted.network}</dd>
          </div>
          <div>
            <dt>Pay to</dt>
            <dd className="mono-tag" title={accepted.payTo}>
              {shortenMiddle(accepted.payTo)}
            </dd>
          </div>
          <div>
            <dt>Time to pay</dt>
            <dd>{accepted.maxTimeoutSeconds}s</dd>
          </div>
        </dl>
      )}
      <ArtifactPanel label="Decoded PAYMENT-REQUIRED" json={required} />
    </div>
  );
}

function BuildArtifact({
  detail,
  maxTimeoutSeconds,
}: {
  detail: { nonce: string; transactionBase64: string };
  maxTimeoutSeconds?: number;
}) {
  const bytes = base64ByteLength(detail.transactionBase64);
  return (
    <div className="artifact-summary">
      <dl className="spec-list">
        <div>
          <dt>Nonce (spent UTxO)</dt>
          <dd className="mono-tag" title={detail.nonce}>
            {shortenMiddle(detail.nonce, 14, 8)}
          </dd>
        </div>
        <div>
          <dt>Signed transaction</dt>
          <dd>{formatBytes(bytes)} of CBOR, base64-encoded</dd>
        </div>
        {maxTimeoutSeconds !== undefined && (
          <div>
            <dt>Time-to-live</dt>
            <dd>
              {maxTimeoutSeconds}s from signing — the facilitator rejects the transaction as stale after this window
            </dd>
          </div>
        )}
      </dl>
      <ArtifactPanel label="Signed transaction (base64 CBOR)" text={detail.transactionBase64} />
    </div>
  );
}

function PayArtifact({ detail, displayPrice }: { detail: unknown; displayPrice: string }) {
  const payload = asPaymentPayload(detail);
  const header = encodePaymentSignatureHeader(payload);
  return (
    <div className="artifact-summary">
      <dl className="spec-list">
        <div>
          <dt>Paying</dt>
          <dd className="mono-tag mono-tag--accent">{displayPrice}</dd>
        </div>
        <div>
          <dt>Header</dt>
          <dd>PAYMENT-SIGNATURE</dd>
        </div>
      </dl>
      <ArtifactPanel label="Decoded PaymentPayload" json={payload} />
      <ArtifactPanel label="Raw PAYMENT-SIGNATURE header value" text={header} />
    </div>
  );
}

function SettledArtifact({ detail }: { detail: unknown }) {
  const { settle, body } = asSettledDetail(detail);
  const failed = settle ? settle.success === false : false;
  const mempool = settle?.success && settle.extra?.status === "mempool";

  return (
    <div className="settled-artifact" data-outcome={failed ? "failed" : mempool ? "mempool" : "confirmed"}>
      {settle?.transaction && (
        <a
          className="tx-chip"
          href={`https://preprod.cardanoscan.io/transaction/${settle.transaction}`}
          target="_blank"
          rel="noreferrer"
        >
          <span className="tx-chip__label">View transaction on preprod</span>
          <span className="mono-tag">{shortenMiddle(settle.transaction, 12, 8)}</span>
          <span className="tx-chip__arrow" aria-hidden="true">
            ↗
          </span>
        </a>
      )}

      {mempool && (
        <p className="step-note" role="status">
          The facilitator accepted this transaction, but it is not yet confirmed in a block.
          It may still be dropped; the explorer may not show it yet.
        </p>
      )}
      {failed && (
        <ErrorNote
          message={settle?.errorMessage ?? settle?.errorReason ?? "The facilitator reported the settlement failed."}
        />
      )}
      <div className="resource-card">
        <p className="resource-card__eyebrow">Paid-for resource</p>
        <pre className="artifact">
          <code>{JSON.stringify(body, null, 2)}</code>
        </pre>
      </div>

      {settle && <ArtifactPanel label="Full settlement receipt" json={settle} />}
    </div>
  );
}
