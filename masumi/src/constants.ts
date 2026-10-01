/**
 * Network constants and small helpers shared by the agent, the scripts and the
 * browser UI. Browser-safe: no Node built-ins.
 */
import { addressCredentials, masumiEscrowAddress, MASUMI_REGISTRY_POLICY_ID } from "@x402/cardano";

/** The x402 (CAIP-2) network id. */
export const NETWORK = "cardano:preprod";
/** The Masumi V2 escrow (`vested_pay`) on preprod, as derived by `@x402/cardano`. */
export const ESCROW_ADDRESS = masumiEscrowAddress(NETWORK);
/** The Masumi registry V2 policy id (same on preprod and mainnet). */
export const REGISTRY_POLICY_ID = MASUMI_REGISTRY_POLICY_ID;

/**
 * Masumi's preprod tUSDM, the token Sokosumi prices in. Not the library's
 * `USDM_PREPROD_ASSET` (policy `e675b46e…`), which is a different token.
 */
export const TUSDM_POLICY_ID = "16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde";
export const TUSDM_ASSET_NAME = "0014df10745553444d";
/** Blockfrost and registry-metadata form: `policyId ++ assetName`. */
export const TUSDM_UNIT = TUSDM_POLICY_ID + TUSDM_ASSET_NAME;
/** x402 form: `policyId.assetName`. */
export const TUSDM_X402_ASSET = `${TUSDM_POLICY_ID}.${TUSDM_ASSET_NAME}`;

/** One comparable form for `lovelace`/`""`, dotted and concatenated units. */
export function unitKey(unit: string): string {
  const u = unit.toLowerCase().replace(".", "");
  return u === "lovelace" ? "" : u;
}

/** The payment key hash (hex) of a key-credential address, a.k.a. `sellerVKey`. */
export function paymentKeyHash(address: string): string {
  const { payment } = addressCredentials(address);
  if (payment.isScript) throw new Error(`${address} has a script payment credential`);
  return payment.hash;
}

/** Joins a metadata leaf that may have been chunked into an array of ≤ 60-byte strings. */
export const metadataText = (value: unknown) =>
  Array.isArray(value) ? value.join("") : typeof value === "string" ? value : undefined;

/** Formats tUSDM base units (6 decimals) for display. */
export const formatTusdm = (units: bigint | string) => `${(Number(units) / 1e6).toFixed(2)} tUSDM`;
