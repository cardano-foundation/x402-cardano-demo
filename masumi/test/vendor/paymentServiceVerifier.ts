/**
 * Independent re-implementation of what a Sokosumi hire does with our
 * `POST /start_job` response, ported from upstream (both MIT):
 *
 * - sokosumi@8327114            packages/masumi/src/schemas/agent/start_job.schema.ts
 *                               apps/core/src/helpers/job.ts (resolved source index)
 *                               packages/masumi/src/clients/masumi-payment.client.ts:555-587
 * - masumi-payment-service@69297f3
 *                               src/routes/api/purchases/shared.ts:37-280 (resolvePurchaseCreationContext)
 *                               src/utils/generator/blockchain-identifier-payload.ts
 *                               packages/payment-core/src/blockchain-identifier.ts
 *                               src/routes/api/registry/wallet/index.ts (metadataSchema, pricing)
 *
 * It deliberately shares no code with `src/`. Only the response body goes in,
 * so a drift in what the agent signs makes these checks fail. Database and
 * Blockfrost lookups are replaced by explicit arguments.
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import stringify from "canonical-json";
import LZString from "lz-string";
import { z } from "zod";

// Mesh's ESM entry trips a libsodium-wrappers-sumo packaging bug; its CommonJS build works.
const { blake2b, checkSignature, getPublicKeyFromCoseKey, resolvePaymentKeyHash } =
  createRequire(import.meta.url)("@meshsdk/core-cst") as typeof import("@meshsdk/core-cst");

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const hex = (s: string) => /^[0-9a-fA-F]+$/.test(s);
const metadataToString = (v: string | string[] | undefined) => v == null ? undefined : typeof v === "string" ? v : v.join("");
const normalizePurchaseUnit = (unit: string) => unit.toLowerCase() === "lovelace" ? "" : unit;

/** Sokosumi `startPaidJobResponseSchema` (the fields and coercions it applies). */
export const startPaidJobResponseSchema = z.preprocess(
  v => typeof v === "object" && v !== null ? { ...v, id: (v as { id?: unknown; job_id?: unknown }).id ?? (v as { job_id?: unknown }).job_id } : v,
  z.object({
    id: z.string().min(1),
    input_hash: z.string().min(1),
    identifierFromPurchaser: z.string().min(1),
    blockchainIdentifier: z.string().min(1),
    payByTime: z.coerce.number().int(),
    submitResultTime: z.coerce.number().int(),
    unlockTime: z.coerce.number().int(),
    externalDisputeUnlockTime: z.coerce.number().int(),
    agentIdentifier: z.string().min(1),
    sellerVKey: z.string().min(1),
    paymentSourceType: z.preprocess(v => v === null || v === "None" ? undefined : v, z.enum(["Web3CardanoV1", "Web3CardanoV2"]).optional()),
    supportedPaymentSourceIndex: z.preprocess(v => typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v.trim()) : undefined, z.number().int().min(0).max(24).optional()),
  }),
);

type PurchaseInput = {
  blockchainIdentifier: string; inputHash: string; sellerVkey: string; agentIdentifier: string;
  identifierFromPurchaser: string; supportedPaymentSourceIndex: number;
  payByTime: string; submitResultTime: string; unlockTime: string; externalDisputeUnlockTime: string;
  Amounts?: Array<{ amount: string; unit: string }>;
};

/**
 * Sokosumi's checks on the response and its `POST /purchase` body. The agent
 * registered one payment source, so the resolved index is that source (0).
 */
export function sokosumiPurchaseBody(body: unknown, expected: { agentIdentifier: string; identifierFromPurchaser: string; amounts: Array<{ amount: string; unit: string }> }): PurchaseInput {
  const response = startPaidJobResponseSchema.parse(body);
  if (response.agentIdentifier.toLowerCase() !== expected.agentIdentifier.toLowerCase()) throw new Error("Paid agent job returned a different agent identifier");
  if (response.identifierFromPurchaser !== expected.identifierFromPurchaser) throw new Error("Paid agent job returned a different purchaser identifier");
  if (response.paymentSourceType !== undefined && response.paymentSourceType !== "Web3CardanoV2") throw new Error("Paid V2 agent job returned an invalid payment source type");
  const resolvedIndex = response.supportedPaymentSourceIndex ?? 0;
  if (resolvedIndex !== 0) throw new Error("Paid V2 agent job returned an unexpected payment source");
  return {
    agentIdentifier: expected.agentIdentifier,
    inputHash: response.input_hash,
    blockchainIdentifier: response.blockchainIdentifier,
    sellerVkey: response.sellerVKey,
    identifierFromPurchaser: expected.identifierFromPurchaser,
    supportedPaymentSourceIndex: resolvedIndex,
    payByTime: response.payByTime.toString(),
    externalDisputeUnlockTime: response.externalDisputeUnlockTime.toString(),
    submitResultTime: response.submitResultTime.toString(),
    unlockTime: response.unlockTime.toString(),
    Amounts: expected.amounts,
  };
}

/** Payment Service `buildSignedBlockchainIdentifierPayload`, V2 branch. */
function buildSignedBlockchainIdentifierPayload(input: {
  inputHash: string; agentIdentifier: string; purchaserIdentifier: string; sellerIdentifier: string;
  requestedFunds: null; payByTime: string; submitResultTime: string; unlockTime: string; externalDisputeUnlockTime: string;
  sellerAddress: string; sellerReturnAddress: string | null; smartContractAddress: string | null; supportedPaymentSourceIndex?: number;
}) {
  return {
    inputHash: input.inputHash,
    agentIdentifier: input.agentIdentifier,
    purchaserIdentifier: input.purchaserIdentifier,
    sellerIdentifier: input.sellerIdentifier,
    RequestedFunds: input.requestedFunds,
    payByTime: input.payByTime,
    submitResultTime: input.submitResultTime,
    unlockTime: input.unlockTime,
    externalDisputeUnlockTime: input.externalDisputeUnlockTime,
    sellerAddress: input.sellerAddress,
    sellerReturnAddress: input.sellerReturnAddress ?? null,
    smartContractAddress: input.smartContractAddress ?? null,
    ...(input.supportedPaymentSourceIndex == null ? {} : { supportedPaymentSourceIndex: input.supportedPaymentSourceIndex }),
  };
}

/** Payment Service `decodeBlockchainIdentifier`. */
export function decodeBlockchainIdentifier(blockchainIdentifier: string) {
  const decompressed = LZString.decompressFromUint8Array(Buffer.from(blockchainIdentifier, "hex"));
  if (typeof decompressed !== "string") return null;
  const parts = decompressed.split(".");
  if (parts.length !== 4 && parts.length !== 5) return null;
  const [sellerId, purchaserId, signature, key, smartContractAddress = null] = parts;
  if (!hex(sellerId) || !hex(purchaserId)) return null;
  if (smartContractAddress != null && (smartContractAddress.length > 250 || !smartContractAddress.startsWith("addr"))) return null;
  return { sellerId, purchaserId, signature, key, agentIdentifier: sellerId.length > 64 ? sellerId.slice(64) : null, smartContractAddress };
}

const text = z.string().min(1).or(z.array(z.string().min(1)));
/** The parts of the Payment Service `metadataSchema` a purchase depends on. */
export const metadataSchema = z.object({
  name: text,
  api_base_url: text,
  author: z.object({ name: text }),
  tags: z.array(z.string().min(1)).min(1),
  image: z.string().or(z.array(z.string())),
  metadata_version: z.coerce.number().int().min(1).max(2),
  supported_payment_sources: z.array(z.object({
    chain: z.string().or(z.array(z.string())),
    network: z.string().or(z.array(z.string())),
    settlement: z.object({ paymentSourceType: z.string().or(z.array(z.string())).optional(), address: z.string().or(z.array(z.string())).optional() }).optional(),
    pricing: z.object({ pricingType: z.string(), fixed: z.array(z.object({ asset: z.string().or(z.array(z.string())), amount: z.string() })).optional() }).optional(),
  })).optional(),
});

/**
 * Payment Service `resolvePurchaseCreationContext` minus the database:
 * timing, NFT holder, metadata, pricing, identifier and signature checks.
 * Throws with the upstream error message on the first failure.
 */
export async function verifyPurchase(input: PurchaseInput, chain: { nftHolderAddress: string; onchainMetadata: unknown; smartContractAddress: string; network: "Preprod" | "Mainnet"; now?: number }) {
  const now = BigInt(chain.now ?? Date.now());
  const [payBy, submit, unlock, dispute] = [input.payByTime, input.submitResultTime, input.unlockTime, input.externalDisputeUnlockTime].map(BigInt);
  const min = (m: number) => BigInt(m * 60_000);
  if (payBy > submit - min(5)) throw new Error("Pay by time must be before submit result time (min. 5 minutes)");
  if (payBy < now - min(5)) throw new Error("Pay by time must be in the future (max. 5 minutes)");
  if (dispute < unlock + min(15)) throw new Error("External dispute unlock time must be after unlock time (min. 15 minutes difference)");
  if (submit < now + min(15)) throw new Error("Submit result time must be in the future (min. 15 minutes)");
  if (submit > unlock - min(15)) throw new Error("Submit result time must be before unlock time with at least 15 minutes difference");

  if (resolvePaymentKeyHash(chain.nftHolderAddress) !== input.sellerVkey) throw new Error("Invalid seller vkey");
  const sellerReturnAddress = null; // no seller hot wallet on the buyer's node; Sokosumi sends none

  const decoded = decodeBlockchainIdentifier(input.blockchainIdentifier);
  if (decoded == null) throw new Error("Invalid blockchain identifier, format invalid");
  const metadata = metadataSchema.safeParse(chain.onchainMetadata);
  if (!metadata.success) throw new Error("Agent identifier metadata invalid or unsupported");
  const source = metadata.data.supported_payment_sources?.[input.supportedPaymentSourceIndex];
  if (source == null) throw new Error(`supportedPaymentSourceIndex ${input.supportedPaymentSourceIndex} is not advertised by this agent`);
  if (metadataToString(source.chain) !== "Cardano") throw new Error("does not select a Cardano payment source");
  if (metadataToString(source.network) !== chain.network) throw new Error("Selected Cardano payment source network does not match the request network");
  if (metadataToString(source.settlement?.paymentSourceType) !== "Web3CardanoV2" || metadataToString(source.settlement?.address) !== decoded.smartContractAddress) {
    throw new Error("Selected Cardano payment source settlement does not match the signed smartContractAddress");
  }
  if (source.pricing?.pricingType !== "Fixed" || !source.pricing.fixed?.length) throw new Error("Agent identifier pricing type not supported");
  const price = new Map<string, bigint>();
  for (const f of source.pricing.fixed) {
    if (!/^\d+$/.test(f.amount)) throw new Error("Agent metadata does not advertise any pricing");
    const unit = normalizePurchaseUnit(metadataToString(f.asset)!);
    price.set(unit, (price.get(unit) ?? 0n) + BigInt(f.amount));
  }
  if (input.Amounts != null) {
    const paid = new Map<string, bigint>();
    for (const a of input.Amounts) paid.set(normalizePurchaseUnit(a.unit), (paid.get(normalizePurchaseUnit(a.unit)) ?? 0n) + BigInt(a.amount));
    if (paid.size !== price.size || [...price].some(([u, a]) => paid.get(u) !== a)) throw new Error("Provided Amounts do not match the fixed pricing of the agent");
  }

  if (decoded.purchaserId !== input.identifierFromPurchaser) throw new Error("Invalid blockchain identifier, purchaser id mismatch");
  if (decoded.agentIdentifier !== input.agentIdentifier) throw new Error("Invalid blockchain identifier, agent identifier mismatch");
  // Upstream: Ed25519PublicKey.fromBytes(key).hash().hex(), i.e. blake2b-224 of the key bytes.
  const keyHash = blake2b(28).update(getPublicKeyFromCoseKey(decoded.key)).digest("hex");
  if (keyHash !== input.sellerVkey) throw new Error("Invalid blockchain identifier, key does not match");
  if (decoded.smartContractAddress !== chain.smartContractAddress) throw new Error("Invalid blockchain identifier, smartContractAddress mismatch");

  const reconstructed = buildSignedBlockchainIdentifierPayload({
    inputHash: input.inputHash,
    agentIdentifier: input.agentIdentifier,
    purchaserIdentifier: decoded.purchaserId,
    sellerIdentifier: decoded.sellerId,
    requestedFunds: null,
    payByTime: input.payByTime,
    submitResultTime: input.submitResultTime,
    unlockTime: unlock.toString(),
    externalDisputeUnlockTime: dispute.toString(),
    sellerAddress: chain.nftHolderAddress,
    sellerReturnAddress,
    smartContractAddress: decoded.smartContractAddress,
    supportedPaymentSourceIndex: input.supportedPaymentSourceIndex,
  });
  if (!await checkSignature(sha256(stringify(reconstructed)), { signature: decoded.signature, key: decoded.key })) {
    throw new Error("Invalid blockchain identifier, signature invalid");
  }
  return { sellerNonce: decoded.sellerId.slice(0, 64), buyerNonce: decoded.purchaserId, referenceKey: decoded.key, referenceSignature: decoded.signature };
}
