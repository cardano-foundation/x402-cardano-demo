import type { FlowStep } from "../x402/flow";

export type StepId = FlowStep["id"];

/** Canonical protocol order — used to size the timeline and to locate the
 * step an in-flight error interrupted (see App.tsx). */
export const STEP_ORDER: StepId[] = ["request", "required", "build", "pay", "settled"];

export interface StepCopy {
  /** Short name for the rail/timeline marker. */
  label: string;
  /** Which actor performs this step — colors the timeline marker. */
  actor: "you" | "seller" | "facilitator" | "chain";
  /** 2-3 sentences: what this step accomplishes in the protocol, and why it exists. */
  why: string;
}

export const STEP_COPY: Record<StepId, StepCopy> = {
  request: {
    label: "The unpaid request",
    actor: "you",
    why: "The client asks for the resource exactly like any HTTP client would — no special headers, no payment attached yet. The server can't demand money before saying what it wants, so it first responds the way HTTP has always let it: with a status code.",
  },
  required: {
    label: "Server names its price",
    actor: "seller",
    why: "402 Payment Required carries a machine-readable PAYMENT-REQUIRED header with the scheme, network, amount, and payment address. The client can inspect those exact terms before asking the wallet to sign.",
  },
  build: {
    label: "Wallet builds and signs",
    actor: "you",
    why: "The browser builds the requested payment from unspent wallet inputs and asks your wallet to approve the signature. One input identifies this payment for the facilitator. Nothing is broadcast yet.",
  },
  pay: {
    label: "Retried with proof of payment",
    actor: "you",
    why: "The identical GET fires again with a PAYMENT-SIGNATURE header containing the signed transaction. The seller asks its facilitator to verify the payment and submit it to Cardano; the browser never broadcasts it.",
  },
  settled: {
    label: "Receipt and resource",
    actor: "facilitator",
    why: "When the payment meets the requested confirmation policy, the seller returns the protected resource and a PAYMENT-RESPONSE receipt. Pending payments are checked automatically. If those checks pause, use Check this payment again; no new wallet approval is needed.",
  },
};
