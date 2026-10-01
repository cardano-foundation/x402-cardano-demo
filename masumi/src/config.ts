/** Environment for the agent and the CLI scripts (Node only). See `.env.example`. */
import "dotenv/config";
import { toMasumiSellerSigner } from "@x402/cardano";
import { NETWORK, REGISTRY_POLICY_ID } from "./constants.js";
import type { AgentListing } from "./masumi.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} in masumi/.env (see .env.example).`);
  return value;
}
const optional = (name: string, fallback: string) => process.env[name]?.trim() || fallback;
/** The agent's display name in the registry and on Sokosumi. */
const agentName = () => optional("AGENT_NAME", "x402 Masumi demo agent");

/** Blockfrost preprod settings; the project id is read lazily. */
export const blockfrost = {
  baseUrl: optional("BLOCKFROST_BASE_URL", "https://cardano-preprod.blockfrost.io/api/v0"),
  get projectId() { return required("BLOCKFROST_PROJECT_ID"); },
};

/** The selling wallet: signs purchase terms and escrow transactions, and holds the registry NFT. */
export function sellerWallet() {
  const mnemonic = required("SELLER_MNEMONIC");
  const signer = toMasumiSellerSigner({ network: NETWORK, mnemonic });
  return { mnemonic, address: signer.sellerAddress, signTerms: signer.signTerms, signer };
}

/** Local HTTP port of the agent. */
export const port = Number(optional("PORT", "8787"));
/** Where the registry and buyers reach this agent, without a trailing slash. */
export const publicUrl = () => required("AGENT_PUBLIC_URL").replace(/\/+$/, "");
/** Price in tUSDM base units (6 decimals). Must equal the registered price. */
export const priceUnits = BigInt(optional("PRICE_TUSDM_UNITS", "1000000"));
/**
 * Optional x402-only price in lovelace (default 5 tADA). This offer is not in
 * the registry, so it carries no agent identifier. Set it empty to disable.
 */
export const adaPriceLovelace = (() => {
  const raw = process.env.X402_ADA_PRICE_LOVELACE;
  const value = raw === undefined ? "5000000" : raw.trim();
  if (!value) return undefined;
  if (!/^[1-9]\d*$/.test(value)) throw new Error("X402_ADA_PRICE_LOVELACE must be a positive integer (lovelace) or empty.");
  return BigInt(value);
})();

/** The registered agent id (`policyId ++ assetName`) from MASUMI_AGENT_IDENTIFIER. */
export function agentIdentifier(): string {
  const id = required("MASUMI_AGENT_IDENTIFIER").toLowerCase();
  if (!id.startsWith(REGISTRY_POLICY_ID) || id.length !== 120) {
    throw new Error("MASUMI_AGENT_IDENTIFIER must be the 120-hex registry asset id printed by `npm run register`.");
  }
  return id;
}

/** What `npm run register` writes into the registry NFT. */
export const listing = (): AgentListing => ({
  name: agentName(),
  description: optional("AGENT_DESCRIPTION", "Demo agent: reverses and upper-cases your text. Pays via Masumi escrow or x402."),
  apiBaseUrl: publicUrl(),
  authorName: optional("AGENT_AUTHOR", "x402 Cardano demo"),
  tags: optional("AGENT_TAGS", "demo,text,x402").split(",").map(t => t.trim()).filter(Boolean),
  image: optional("AGENT_IMAGE", "ipfs://QmXXW7tmBgpQpXoJMAMEXXFe9dyQcrLFKGuzxnHDnbKC7f"),
  priceUnits,
});
