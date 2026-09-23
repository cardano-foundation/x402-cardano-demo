/** The educational HTTP loop; x402 owns the payloads and header codecs. */
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentPayload } from "@x402/core/types";
import { ExactCardanoScheme } from "@x402/cardano/exact/client";
import { decodeCardanoTransaction, USDM_PREPROD_ASSET, type ClientCardanoSigner } from "@x402/cardano";

export type FlowStep =
  | { id: "request"; title: string; detail: { url: string; status: number } }
  | { id: "required"; title: string; detail: unknown }
  | { id: "build"; title: string; detail: { nonce: string; transactionBase64: string } }
  | { id: "pay"; title: string; detail: unknown }
  | { id: "settled"; title: string; detail: unknown };
export type PaymentMethod = "default" | "masumi" | "usdm" | "masumi-usdm";
export interface PreparedPayment { url: string; headers: Record<string, string>; payload: PaymentPayload }
export type FlowOutcome = { status: "settled" } | { status: "failed"; message: string } | {
  status: "pending" | "unknown"; payment: PreparedPayment; message: string; transaction?: string; retryable?: boolean;
};
export interface RecoveryOptions { automaticChecks?: number; retryDelayMs?: number }
export interface FlowOptions extends RecoveryOptions { l1Confirmations?: number; asset?: string; amount?: string }
const paths: Record<PaymentMethod, string> = {
  default: "/api/message", usdm: "/api/message-usdm", masumi: "/api/message-masumi", "masumi-usdm": "/api/message-masumi-usdm",
};
const amounts: Record<PaymentMethod, string> = { default: "2000000", usdm: "100000", masumi: "5000000", "masumi-usdm": "250000" };

export async function runPaymentFlow(
  serverUrl: string, signer: ClientCardanoSigner, onStep: (step: FlowStep) => void,
  method: PaymentMethod = "default", options: FlowOptions = {},
): Promise<FlowOutcome> {
  const url = new URL(paths[method], serverUrl);
  // This identifies one application operation, including across paid retries.
  url.searchParams.set("requestId", crypto.randomUUID());
  url.searchParams.set("confirmations", String(options.l1Confirmations ?? 1));
  const first = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  onStep({ id: "request", title: "Request the resource", detail: { url: url.href, status: first.status } });
  if (first.status !== 402) throw new Error(`Expected a payment offer, received HTTP ${first.status}.`);
  const http = new x402HTTPClient(x402Client.fromConfig({
    schemes: [{ network: "cardano:preprod", client: new ExactCardanoScheme(signer) }],
    spendControls: { allowedAssets: [{ network: "cardano:preprod", asset: options.asset ?? (method.includes("usdm") ? USDM_PREPROD_ASSET : "lovelace"), maxAmountPerPayment: options.amount ?? amounts[method] }] },
    policies: [(_version, offers) => offers.filter(offer =>
      offer.asset === (options.asset ?? (method.includes("usdm") ? USDM_PREPROD_ASSET : "lovelace")) &&
      offer.amount === (options.amount ?? amounts[method]) &&
      (offer.extra?.assetTransferMethod ?? "default") === (method.startsWith("masumi") ? "masumi" : "default") &&
      ((offer.extra?.confirmationPolicy as { l1Confirmations?: number } | undefined)?.l1Confirmations ?? 1) === (options.l1Confirmations ?? 1)
    )],
  }));
  const required = http.getPaymentRequiredResponse(name => first.headers.get(name));
  onStep({ id: "required", title: "Read the payment offer", detail: required });
  if (method.startsWith("masumi")) {
    // This demo buys only this GET URL. Refuse a seller commitment to other work.
    for (const offer of required.accepts) {
      const parts = (offer.extra?.inputCommitment as { parts?: Array<{ name: string; canonicalization: string; content?: unknown }> } | undefined)?.parts;
      if (!parts || parts.length !== 1 || parts[0].name !== "resource" || parts[0].canonicalization !== "jcs" || JSON.stringify(parts[0].content) !== JSON.stringify({ url: url.href })) {
        throw new Error("The escrow offer does not describe the request you made.");
      }
    }
  }
  const payload = await http.createPaymentPayload(required);
  onStep({ id: "build", title: "Wallet signed the transaction", detail: {
    nonce: String(payload.payload.nonce), transactionBase64: String(payload.payload.transaction),
  } });
  const payment = { url: url.href, payload, headers: http.encodePaymentSignatureHeader(payload) };
  return settleWithRecovery(payment, onStep, false, options);
}

/** Resume observation of the same payment. This function cannot access a signer. */
export function resumePaymentFlow(payment: PreparedPayment, onStep: (step: FlowStep) => void, options: RecoveryOptions = {}): Promise<FlowOutcome> {
  return settleWithRecovery(payment, onStep, true, options);
}

async function settleWithRecovery(payment: PreparedPayment, onStep: (step: FlowStep) => void, resuming: boolean, options: RecoveryOptions): Promise<FlowOutcome> {
  const limit = Math.min(5, Math.max(0, Math.trunc(options.automaticChecks ?? 0)));
  let outcome = await sendPayment(payment, onStep, resuming);
  let earlierIssue = outcome.status === "unknown" ? outcome.message : undefined;
  let checks = 0;
  // Serial checks reuse the exact URL and signed bytes. No wallet is available
  // here, and a transport failure never authorizes a replacement payment.
  while ((outcome.status === "pending" || (outcome.status === "unknown" && outcome.retryable)) && checks < limit) {
    await new Promise(resolve => setTimeout(resolve, options.retryDelayMs ?? 5_000));
    checks++;
    outcome = await sendPayment(payment, onStep, true);
    if (outcome.status === "unknown") earlierIssue ??= outcome.message;
  }
  if (checks === limit && limit > 0 && (outcome.status === "pending" || (outcome.status === "unknown" && outcome.retryable))) {
    return { ...outcome, message: `Automatic checks paused after ${checks} attempts. ${outcome.message}${earlierIssue && earlierIssue !== outcome.message ? ` Earlier check: ${earlierIssue}` : ""}` };
  }
  return outcome;
}

async function sendPayment(payment: PreparedPayment, onStep: (step: FlowStep) => void, resuming: boolean): Promise<FlowOutcome> {
  onStep({ id: "pay", title: resuming ? "Check the same payment" : "Send the signed payment", detail: payment.payload });
  const transaction = decodeCardanoTransaction(String(payment.payload.payload.transaction)).txHash;
  const unknown = (message: string, retryable = false): FlowOutcome => ({ status: "unknown", payment, transaction, message, retryable });
  let response: Response;
  try { response = await fetch(payment.url, { headers: payment.headers, signal: AbortSignal.timeout(240_000) }); }
  catch { return unknown("The connection was interrupted. The payment may have been submitted. Check this payment again; do not pay a second time.", true); }
  const receiptHeader = response.headers.get("PAYMENT-RESPONSE");
  let receipt;
  try { receipt = receiptHeader ? decodePaymentResponseHeader(receiptHeader) : undefined; }
  catch { return unknown("The server returned an unreadable receipt. Check this payment again."); }
  if (receiptHeader && typeof receipt?.success !== "boolean") {
    return unknown("The server returned an invalid receipt. Keep this payment for checking.");
  }
  if (receipt && (receipt.transaction !== transaction || receipt.network !== payment.payload.accepted.network)) {
    return unknown("The receipt does not match this payment. Keep this transaction for checking.");
  }
  if (receipt?.errorReason === "settlement_pending") {
    const detail = typeof receipt.errorMessage === "string" ? receipt.errorMessage.slice(0, 500) : "Your transaction is still waiting for confirmation";
    return { status: "pending", payment, transaction: receipt.transaction || transaction, message: `${detail}. Check the same payment again without signing or paying again.` };
  }
  if (receipt?.success) {
    if (!response.ok) return unknown(`Payment settled, but the resource returned HTTP ${response.status}. Check the same payment to recover the response.`, true);
    let body;
    try { body = await response.json(); }
    catch { return unknown("Payment settled, but the resource response was interrupted. Check the same payment to recover it.", true); }
    onStep({ id: "settled", title: "Payment accepted", detail: { settle: receipt, body } });
    return { status: "settled" };
  }
  // A generic submission failure can hide a successful broadcast. Only these
  // explicit terminal receipts make it safe to release the saved payment.
  if (receipt?.errorReason === "exact_cardano_settlement_definitively_rejected" ||
      (receipt?.errorReason === "exact_cardano_settlement_failed" && receipt.extra?.status === "expired")) {
    return { status: "failed", message: receipt.extra?.status === "expired"
      ? "The transaction expired without settling. You can start a new payment."
      : `Payment did not settle: ${receipt.errorReason}. You can start a new payment.` };
  }
  const requiredHeader = response.headers.get("PAYMENT-REQUIRED");
  if (response.status === 402 && requiredHeader) {
    let reason = "Payment was rejected before submission.";
    try { reason = decodePaymentRequiredHeader(requiredHeader).error || reason; } catch { /* keep the readable fallback */ }
    if (resuming) {
      // A failed re-verification is different from settlement_pending. Surface
      // its cause, but keep the signed payment: rejection is not a receipt
      // proving that an earlier submission cannot still land.
      return unknown(`The server rejected this payment check: ${reason}. Keep this payment and check the server log before trying a new payment.`);
    }
    throw new Error(`Payment rejected: ${reason}`);
  }
  const reason = typeof receipt?.errorMessage === "string" ? ` ${receipt.errorMessage.slice(0, 500)}.` : "";
  return unknown(`Payment status is not confirmed (HTTP ${response.status}${receipt?.errorReason ? `: ${receipt.errorReason}` : ""}).${reason} Check the same payment again.`, response.status >= 500 || receipt?.errorReason === "exact_cardano_settlement_failed");
}
