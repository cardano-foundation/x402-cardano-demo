/**
 * Pure Masumi helpers (Node only): registry NFT naming and metadata, MIP-004
 * hashes, the standard (Payment Service compatible) purchase terms, and the
 * SubmitResult datum transition. No network access happens here.
 */
import { createHash, randomBytes } from "node:crypto";
import { blake2b } from "@noble/hashes/blake2.js";
import { Data } from "@evolution-sdk/evolution";
import { jcs, MASUMI_PAYMENT_SOURCE_TYPE } from "@x402/cardano";
import { ESCROW_ADDRESS, paymentKeyHash, TUSDM_UNIT } from "./constants.js";
import stringify from "canonical-json";
import LZString from "lz-string";

/** Hex SHA-256 of a UTF-8 string. */
export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

// ---------------------------------------------------------------- registry

/**
 * The 32-byte registry asset name the V2 mint policy accepts:
 * `0x10 ++ blake2b_224(seedTxHash ++ u32be(seedIndex)) ++ 000000` (registry-v2 `mint.ak`).
 */
export function registryAssetName(seedTxHash: string, seedIndex: number): string {
  const ref = Buffer.concat([Buffer.from(seedTxHash, "hex"), Buffer.alloc(4)]);
  ref.writeUInt32BE(seedIndex, 32);
  return `10${Buffer.from(blake2b(ref, { dkLen: 28 })).toString("hex")}000000`;
}

/** Cardano metadata strings are limited to 64 bytes; Masumi chunks at 60 bytes. */
export function toMetadataChunks(text: string): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const char of text) {
    if (Buffer.byteLength(current + char) > 60) { chunks.push(current); current = ""; }
    current += char;
  }
  if (current) chunks.push(current);
  return chunks;
}

/** What the registry NFT says about the agent. */
export interface AgentListing {
  name: string;
  description: string;
  apiBaseUrl: string;
  authorName: string;
  tags: string[];
  image: string;
  /** Price in tUSDM base units (6 decimals). */
  priceUnits: bigint;
}

/**
 * Registry V2 metadata for a Standard agent with one Masumi V2 escrow source
 * and a fixed tUSDM price. Mirrors the Payment Service's own builder
 * (`payment-source-v2/src/services/registry/register/service.ts`), so that the
 * registry service, the Payment Service and Sokosumi all parse it.
 */
export function registryMetadata(agent: AgentListing) {
  if (agent.priceUnits <= 0n) throw new Error("The price must be positive.");
  for (const tag of agent.tags) {
    if (!tag || Buffer.byteLength(tag) > 64) throw new Error(`Tag "${tag}" must be 1-64 bytes.`);
  }
  return {
    name: toMetadataChunks(agent.name),
    description: toMetadataChunks(agent.description),
    api_base_url: toMetadataChunks(agent.apiBaseUrl),
    author: { name: toMetadataChunks(agent.authorName) },
    tags: agent.tags,
    image: toMetadataChunks(agent.image),
    metadata_version: "2",
    supported_payment_sources: [{
      chain: toMetadataChunks("Cardano"),
      network: toMetadataChunks("Preprod"),
      settlement: {
        paymentSourceType: toMetadataChunks(MASUMI_PAYMENT_SOURCE_TYPE),
        address: toMetadataChunks(ESCROW_ADDRESS),
      },
      pricing: { pricingType: "Fixed", fixed: [{ asset: toMetadataChunks(TUSDM_UNIT), amount: agent.priceUnits.toString() }] },
    }],
  };
}

// ---------------------------------------------------------------- MIP-004

/** MIP-004 input hash: `sha256(identifier_from_purchaser + ";" + JCS(input_data))`. */
export const inputHash = (identifierFromPurchaser: string, inputData: unknown) =>
  sha256(`${identifierFromPurchaser};${jcs(inputData)}`);

/** MIP-004 result hash: `sha256(identifier_from_purchaser + ";" + output)`. */
export const resultHash = (identifierFromPurchaser: string, output: string) =>
  sha256(`${identifierFromPurchaser};${output}`);

// ---------------------------------------------------------------- standard path

/**
 * Deadline offsets for standard-path jobs (ms after `start_job`). They satisfy
 * the Payment Service's `/purchase` rules (purchases/shared.ts): pay-by at
 * least 5 min before submit-result; submit-result at least 15 min in the
 * future and 15 min before unlock; dispute at least 15 min after unlock.
 */
export const STANDARD_DEADLINES = {
  payBy: 15 * 60_000,                // the buyer's node must lock within 15 min
  submitResult: 40 * 60_000,         // the agent must put the result hash on chain within 40 min
  unlock: 60 * 60_000,               // the seller may withdraw from 60 min
  externalDisputeUnlock: 80 * 60_000, // the dispute window closes at 80 min
};

/** CIP-8 `signData(address, payloadHex)`, e.g. `toMasumiSellerSigner(...).signTerms`. */
export type Signer = (address: string, payloadHex: string) => Promise<{ key: string; signature: string }> | { key: string; signature: string };

/** Output of {@link standardTerms}: the response plus what the lock must carry. */
export interface StandardTerms {
  /** The MIP-003 `start_job` response body, minus the job id. */
  response: {
    blockchainIdentifier: string;
    payByTime: number; submitResultTime: number; unlockTime: number; externalDisputeUnlockTime: number;
    agentIdentifier: string; sellerVKey: string; identifierFromPurchaser: string; input_hash: string;
    paymentSourceType: string; supportedPaymentSourceIndex: number;
  };
  sellerNonce: string;
  referenceKey: string;
  referenceSignature: string;
}

/**
 * Issues the purchase terms a Masumi Payment Service buyer (Sokosumi) accepts,
 * signed by the seller key. Follows the Payment Service seller flow
 * (`src/routes/api/payments/index.ts` and `blockchain-identifier-payload.ts`):
 * sign `sha256(canonical-json(payload))` with CIP-8, then pack
 * `sellerNonce+agentIdentifier . purchaserId . signature . key . escrow` with LZString.
 */
export async function standardTerms(input: {
  identifierFromPurchaser: string;
  inputData: unknown;
  agentIdentifier: string;
  /** The exact bech32 address holding the registry NFT. */
  sellerAddress: string;
  sign: Signer;
  now?: number;
}): Promise<StandardTerms> {
  const now = input.now ?? Date.now();
  const times = {
    payByTime: now + STANDARD_DEADLINES.payBy,
    submitResultTime: now + STANDARD_DEADLINES.submitResult,
    unlockTime: now + STANDARD_DEADLINES.unlock,
    externalDisputeUnlockTime: now + STANDARD_DEADLINES.externalDisputeUnlock,
  };
  const hash = inputHash(input.identifierFromPurchaser, input.inputData);
  const sellerNonce = randomBytes(32).toString("hex");
  const sellerIdentifier = sellerNonce + input.agentIdentifier;
  const supportedPaymentSourceIndex = 0;
  // Every key and value matters: the buyer node rebuilds this object and
  // verifies the signature over it. See test/standard-path.test.ts.
  const payload = {
    inputHash: hash,                                  // MIP-004 hash of the job input
    agentIdentifier: input.agentIdentifier,           // registry NFT (policy ++ asset name)
    purchaserIdentifier: input.identifierFromPurchaser, // the buyer's nonce, echoed
    sellerIdentifier,                                 // our nonce ++ agent id; the nonce becomes the datum's seller_nonce
    RequestedFunds: null,                             // null for Fixed pricing (the price is in the registry)
    payByTime: String(times.payByTime),               // times are signed as decimal strings, not numbers
    submitResultTime: String(times.submitResultTime),
    unlockTime: String(times.unlockTime),
    externalDisputeUnlockTime: String(times.externalDisputeUnlockTime),
    sellerAddress: input.sellerAddress,               // must equal the NFT holder's bech32 exactly
    sellerReturnAddress: null,                        // the buyer's node has no hot wallet for us
    smartContractAddress: ESCROW_ADDRESS,             // the V2 escrow; also the identifier's 5th segment
    supportedPaymentSourceIndex,                      // a number: Sokosumi always forwards the resolved index
  };
  const { key, signature } = await input.sign(input.sellerAddress, sha256(stringify(payload)));
  const identifier = [sellerIdentifier, input.identifierFromPurchaser, signature, key, ESCROW_ADDRESS].join(".");
  return {
    response: {
      blockchainIdentifier: Buffer.from(LZString.compressToUint8Array(identifier)).toString("hex"),
      ...times,
      agentIdentifier: input.agentIdentifier,
      sellerVKey: paymentKeyHash(input.sellerAddress),
      identifierFromPurchaser: input.identifierFromPurchaser,
      input_hash: hash,
      paymentSourceType: MASUMI_PAYMENT_SOURCE_TYPE,
      supportedPaymentSourceIndex,
    },
    sellerNonce,
    referenceKey: key,
    referenceSignature: signature,
  };
}

// ---------------------------------------------------------------- escrow datum

/** `vested_pay` state constructor indices. */
export const STATE = { FundsLocked: 0n, ResultSubmitted: 1n } as const;

/**
 * The SubmitResult continuation datum: identical to the lock datum except
 * field 11 (`result_hash`), 16 (`seller_cooldown_time`) and 18 (`state`).
 * Field 17 (`buyer_cooldown_time`) must be 0 on the continuation; the lock
 * matcher only accepts locks where it already is, and we pin it anyway.
 */
export function submitResultDatum(lock: Data.Data, resultHashHex: string, sellerCooldownTime: bigint): Data.Data {
  if (!Data.isConstr(lock) || lock.index !== 0n || lock.fields.length !== 19) throw new Error("Not a vested_pay V2 datum.");
  const fields = [...lock.fields];
  fields[11] = Data.bytearray(resultHashHex);
  fields[16] = Data.int(sellerCooldownTime);
  fields[17] = Data.int(0n);
  fields[18] = Data.constr(STATE.ResultSubmitted, []);
  return Data.constr(0n, fields);
}
