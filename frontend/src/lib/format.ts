/** Small, dependency-free formatting helpers for rendering protocol artifacts. */

/** `addr_test1qz...9xyz` -> `addr_test1qz…9xyz`. */
export function shortenMiddle(value: string, head = 10, tail = 6): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/** Lovelace (as a decimal string, per the x402 wire format) -> "2 ADA". */
export function lovelaceToAda(lovelace: string | number): string {
  const n = typeof lovelace === "string" ? BigInt(lovelace) : BigInt(Math.round(lovelace));
  const whole = n / 1_000_000n;
  const frac = n % 1_000_000n;
  if (frac === 0n) return `${whole} ADA`;
  const fracStr = frac.toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole}.${fracStr} ADA`;
}

/** Decoded byte length of a base64 string, without allocating the bytes. */
export function base64ByteLength(base64: string): number {
  const clean = base64.replace(/[^A-Za-z0-9+/=]/g, "");
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/** mm:ss elapsed-time readout for the settlement wait. */
export function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Human explanations for the facilitator's wire-identical error codes
 * (see facilitator ErrorCodes.java / x402/typescript mechanisms/cardano/src/constants.ts).
 * Falls back to `undefined` for codes not worth elaborating on in the UI.
 */
const ERROR_EXPLANATIONS: Record<string, string> = {
  network_mismatch: "The wallet is signing for a different network than the server requested.",
  exact_cardano_facilitator_chain_lookup_failed:
    "The facilitator couldn't look up a referenced UTxO on-chain — a node or provider error, not a problem with the payment itself.",
  invalid_exact_cardano_payload_unsigned: "The transaction the wallet returned has no signature on it.",
  invalid_exact_cardano_payload_invalid_signature: "The signature on the transaction doesn't check out against the wallet's key.",
  invalid_exact_cardano_payload_ttl_expired: "The transaction's time-to-live slot has already passed — it took too long to reach the facilitator.",
  invalid_exact_cardano_payload_nonce_invalid: "The nonce UTxO reference is malformed.",
  invalid_exact_cardano_payload_nonce_not_in_inputs: "The nonce UTxO isn't actually spent by this transaction, so it can't prove uniqueness.",
  invalid_exact_cardano_payload_nonce_not_on_chain: "The nonce UTxO doesn't exist on-chain — it may already be spent.",
  invalid_exact_cardano_payload_input_not_available: "One of the transaction's inputs is no longer available (already spent elsewhere).",
  invalid_exact_cardano_payload_recipient_mismatch: "The transaction doesn't pay the address the server asked for.",
  invalid_exact_cardano_payload_asset_mismatch: "The transaction pays in a different asset than the server requested.",
  invalid_exact_cardano_payload_amount_insufficient: "The transaction pays less than the server's price.",
  invalid_exact_cardano_payload_min_utxo_insufficient: "The payment output is below Cardano's minimum UTxO size.",
  settlement_pending: "Settlement has not reached a final result yet. Check this same payment again; do not sign a replacement.",
  exact_cardano_settlement_not_confirmed: "The requested confirmation depth was not reached before the facilitator stopped waiting.",
  exact_cardano_settlement_failed: "The facilitator could not complete settlement on Cardano.",
  exact_cardano_settlement_definitively_rejected: "Cardano definitively rejected this transaction, so it is safe to start a new payment.",
  exact_cardano_facilitator_evidence_unavailable: "The facilitator could not determine the transaction's current on-chain status.",
  duplicate_settlement: "This exact nonce has already been settled once — replay protection is doing its job.",
  masumi_terms_unknown: "The facilitator no longer has the issued Masumi terms for this payment.",
  masumi_terms_mismatch: "The submitted Masumi payment does not match the terms issued for this request.",
};

export function explainErrorCode(code: string): string | undefined {
  return ERROR_EXPLANATIONS[code];
}

/** Finds the first known facilitator error code embedded in a free-text error message. */
export function findErrorCode(message: string): string | undefined {
  return Object.keys(ERROR_EXPLANATIONS).find((code) => message.includes(code));
}
