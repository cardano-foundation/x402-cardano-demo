import { ERR_SETTLEMENT_FAILED, ERR_SETTLEMENT_PENDING, withCardanoProviderTimeout, type FacilitatorCardanoSigner } from "@x402/cardano";
import type { SettleResponse } from "@x402/core/types";

/** The published SDK can turn failed evidence lookups into "unknown" and then
 * report expiry using its local clock. Require a successful lookup before that
 * terminal result can authorize the client to start a replacement payment. */
export async function confirmExpiry(result: SettleResponse, signer: FacilitatorCardanoSigner): Promise<SettleResponse> {
  if (result.success || result.errorReason !== ERR_SETTLEMENT_FAILED || result.extra?.status !== "expired") return result;
  let errorMessage = "Settlement evidence changed while checking expiry. Check the same payment again.";
  try {
    const evidence = signer.getTransactionEvidence && await withCardanoProviderTimeout(
      signer.getTransactionEvidence(result.transaction, result.network), 15_000, "expiry evidence",
    );
    if (evidence?.status === "unknown") return result;
  } catch {
    errorMessage = "The transaction lookup is unavailable, so expiry cannot be confirmed. Check the same payment again.";
  }
  // Leave confirmation policy and success decisions to the next official settle
  // call. Missing evidence can only keep a payment pending, never unlock it.
  return { ...result, success: false, errorReason: ERR_SETTLEMENT_PENDING, errorMessage,
    extra: { ...result.extra, status: "pending", transactionId: result.transaction } };
}
