/**
 * `FlowStep.detail` is typed `unknown` in flow.ts (Task 14 deliberately keeps
 * the protocol module free of UI concerns). These are the real wire shapes
 * from `@x402/core/types`, imported type-only so we can safely narrow each
 * step's `detail` for rendering without re-declaring the protocol's types.
 *
 * flow.ts is the sole producer of these values and its shape is already
 * verified against the built `@x402/core` source (see cip30Signer.ts /
 * flow.ts headers) — the `as` casts below are trusted, not re-validated.
 */
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SettleResponse,
} from "@x402/core/types";

export type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse };

export function asPaymentRequired(detail: unknown): PaymentRequired {
  return detail as PaymentRequired;
}

export function asPaymentPayload(detail: unknown): PaymentPayload {
  return detail as PaymentPayload;
}

export interface SettledDetail {
  settle: SettleResponse | null;
  body: { message?: string; paidAt?: string } & Record<string, unknown>;
}

export function asSettledDetail(detail: unknown): SettledDetail {
  return detail as SettledDetail;
}

/** The single `exact` / `cardano:preprod` option a x402 server offers today. */
export function pickCardanoRequirements(required: PaymentRequired): PaymentRequirements | undefined {
  return required.accepts.find((a) => a.scheme === "exact" && a.network === "cardano:preprod");
}
