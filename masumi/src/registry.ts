/**
 * Registry-claim validator for `@x402/cardano`. A Masumi quote that names an
 * `agentIdentifier` is only accepted when the buyer (UI) and the facilitator
 * (agent) independently confirm the claim on chain. Browser-safe.
 */
import type { MasumiRegistryValidator } from "@x402/cardano";
import { ESCROW_ADDRESS, metadataText, NETWORK, paymentKeyHash, REGISTRY_POLICY_ID, unitKey } from "./constants.js";

/** Blockfrost endpoint and project id. */
export interface Blockfrost { baseUrl: string; projectId: string }
type Fetch = (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

interface Source {
  chain?: unknown; network?: unknown;
  settlement?: { paymentSourceType?: unknown; address?: unknown };
  pricing?: { pricingType?: unknown; fixed?: Array<{ asset?: unknown; amount?: unknown }> };
}

/**
 * Accepts a claim only if the registry NFT `agentIdentifier`:
 * - carries V2 metadata with exactly one Cardano/Preprod/Web3CardanoV2 source on the escrow address,
 * - prices exactly the signed amount of the signed asset (Fixed, one entry),
 * - lists an `api_base_url` that the paid resource URL lives under,
 * - is currently held by an address with the seller's payment key.
 */
export function makeRegistryValidator(blockfrost: Blockfrost, fetchImpl: Fetch = fetch): MasumiRegistryValidator {
  const get = async (path: string) => {
    const response = await fetchImpl(`${blockfrost.baseUrl}${path}`, { headers: { project_id: blockfrost.projectId } });
    if (!response.ok) throw new Error(`Blockfrost ${path} returned ${response.status}`);
    return response.json();
  };
  return async claim => {
    try {
      if (claim.network !== NETWORK || !claim.agentIdentifier.startsWith(REGISTRY_POLICY_ID)) return false;
      const asset = await get(`/assets/${claim.agentIdentifier}`) as { onchain_metadata?: { api_base_url?: unknown; supported_payment_sources?: Source[] } };
      const metadata = asset.onchain_metadata;
      const sources = metadata?.supported_payment_sources;
      if (!Array.isArray(sources) || sources.length !== 1) return false;
      const [source] = sources;
      const fixed = source.pricing?.fixed;
      if (metadataText(source.chain) !== "Cardano" || metadataText(source.network) !== "Preprod"
        || metadataText(source.settlement?.paymentSourceType) !== "Web3CardanoV2"
        || metadataText(source.settlement?.address) !== ESCROW_ADDRESS
        || source.pricing?.pricingType !== "Fixed" || !Array.isArray(fixed) || fixed.length !== 1
        || unitKey(metadataText(fixed[0].asset) ?? "-") !== unitKey(claim.asset)
        || metadataText(fixed[0].amount) !== claim.amount) return false;

      const base = metadataText(metadata?.api_base_url)?.replace(/\/+$/, "");
      if (!base || !(claim.resource.url === base || claim.resource.url.startsWith(`${base}/`))) return false;

      const holders = await get(`/assets/${claim.agentIdentifier}/addresses`) as Array<{ address: string; quantity: string }>;
      const seller = paymentKeyHash(claim.sellerAddress);
      return holders.some(h => h.quantity === "1" && paymentKeyHash(h.address) === seller);
    } catch {
      return false;
    }
  };
}
