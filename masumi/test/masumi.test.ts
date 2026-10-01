import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createRequire } from "node:module";
import { Data } from "@evolution-sdk/evolution";
import { buildMasumiLockDatum, jcs, MASUMI_BLUEPRINT_DIGEST, MASUMI_DEFAULT_DEPLOYMENT, MASUMI_REGISTRY_POLICY_ID, masumiEscrowScriptHash, parseMasumiLockDatum, toMasumiSellerSigner } from "@x402/cardano";
import { z } from "zod";
import { ESCROW_ADDRESS, TUSDM_UNIT, unitKey } from "../src/constants.js";
import { paymentScript, registryScript, scriptHash } from "../src/chain.js";
import { inputHash, registryAssetName, registryMetadata, resultHash, submitResultDatum } from "../src/masumi.js";
import { metadataSchema as paymentServiceMetadataSchema } from "./vendor/paymentServiceVerifier.js";

const { blake2b } = createRequire(import.meta.url)("@meshsdk/core-cst") as typeof import("@meshsdk/core-cst");
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const blueprint = JSON.parse(readFileSync(new URL("../contracts/payment-v2.plutus.json", import.meta.url), "utf8"));

test("vendored payment blueprint digest matches MASUMI_BLUEPRINT_DIGEST", () => {
  assert.equal(sha256(jcs(blueprint)), MASUMI_BLUEPRINT_DIGEST);
});

test("escrow script hash matches @x402/cardano deployment", () => {
  assert.equal(scriptHash(paymentScript()), masumiEscrowScriptHash(MASUMI_DEFAULT_DEPLOYMENT));
  assert.equal(scriptHash(paymentScript()), "a15ce9d82d2f67645fc624e2edac03c6f1c106d0ad1af5815a3b14ad");
});

test("registry policy id matches MASUMI_REGISTRY_POLICY_ID", () => {
  assert.equal(scriptHash(registryScript()), MASUMI_REGISTRY_POLICY_ID);
});

test("registry asset name follows mint.ak (nonce 10, blake2b_224 of the seed ref, version 000000)", () => {
  const txHash = "a".repeat(64);
  const ref = Buffer.from(`${txHash}${(7).toString(16).padStart(8, "0")}`, "hex");
  const expected = `10${blake2b(28).update(ref).digest("hex")}000000`;
  assert.equal(registryAssetName(txHash, 7), expected);
  assert.equal(registryAssetName(txHash, 7).length, 64);
});

// masumi-registry-service@HEAD src/services/cardano-registry/web3-cardano-v2-metadata.ts (strict).
const ms = z.string().or(z.array(z.string()));
const registryServiceSchema = z.object({
  name: ms, description: ms.optional(), type: z.string().optional(), api_base_url: ms.optional(),
  author: z.object({ name: ms, contact_email: ms.optional(), contact_other: ms.optional(), organization: ms.optional() }),
  tags: z.array(z.string().min(1)).min(1),
  image: ms,
  metadata_version: z.coerce.number().int().min(2).max(2),
  supported_payment_sources: z.array(z.object({
    chain: ms, network: ms,
    settlement: z.object({ paymentSourceType: ms.optional(), address: ms.optional() }).strict().optional(),
    pricing: z.object({ pricingType: ms, fixed: z.array(z.object({ asset: ms, amount: ms, decimals: ms.optional() })).optional() }).strict().optional(),
  }).strict()).min(1).max(25),
}).strict();

const leaves = (v: unknown): string[] => typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(leaves) : v && typeof v === "object" ? Object.values(v).flatMap(leaves) : [];

test("registry metadata is a Sokosumi-listable V2 entry", () => {
  const metadata = JSON.parse(JSON.stringify(registryMetadata({
    name: "Masumi x402 demo agent", description: "Reverses and upper-cases text. ".repeat(4), apiBaseUrl: "https://agent.example.com",
    authorName: "Demo", tags: ["demo", "x402"], image: "ipfs://QmXXW7tmBgpQpXoJMAMEXXFe9dyQcrLFKGuzxnHDnbKC7f", priceUnits: 1_000_000n,
  })));
  assert.ok(registryServiceSchema.safeParse(metadata).success, "registry-service schema");
  assert.ok(paymentServiceMetadataSchema.safeParse(metadata).success, "Payment Service schema");
  assert.equal(metadata.type, undefined, "Standard entries carry no type");
  const [source] = metadata.supported_payment_sources;
  assert.equal(metadata.supported_payment_sources.length, 1);
  assert.equal(source.settlement.address.join(""), ESCROW_ADDRESS);
  assert.equal(source.settlement.paymentSourceType.join(""), "Web3CardanoV2");
  assert.equal(source.pricing.pricingType, "Fixed");
  assert.equal(source.pricing.fixed[0].asset.join(""), TUSDM_UNIT);
  assert.ok(!TUSDM_UNIT.includes("."), "metadata uses the concatenated unit");
  assert.equal(source.pricing.fixed[0].amount, "1000000");
  for (const leaf of leaves(metadata)) assert.ok(Buffer.byteLength(leaf) <= 64, `leaf over 64 bytes: ${leaf}`);
});

test("units compare across dotted, concatenated and lovelace forms", () => {
  assert.equal(unitKey("16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde.0014df10745553444d"), TUSDM_UNIT);
  assert.equal(unitKey("lovelace"), "");
  assert.notEqual(unitKey("e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9.0014df10745553444d"), TUSDM_UNIT);
});

test("MIP-004 hashes", () => {
  assert.equal(inputHash("abc", { text: "hi", a: 1 }), sha256('abc;{"a":1,"text":"hi"}'));
  assert.equal(resultHash("abc", "IH"), sha256("abc;IH"));
});

const seller = toMasumiSellerSigner({ network: "cardano:preprod", mnemonic: "test test test test test test test test test test test junk" });
const buyer = toMasumiSellerSigner({ network: "cardano:preprod", accountIndex: 1, mnemonic: "test test test test test test test test test test test junk" });
const lockInput = {
  buyerAddress: buyer.sellerAddress, sellerAddress: seller.sellerAddress,
  referenceKey: "a4".repeat(20), referenceSignature: "84".repeat(40), sellerNonce: "11".repeat(32), buyerNonce: "22".repeat(10),
  agentIdentifier: "67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b" + "10" + "ab".repeat(28) + "000000",
  collateralReturnLovelace: 0n, inputHash: "33".repeat(32),
  payByTime: 1_000n, submitResultTime: 2_000n, unlockTime: 3_000n, externalDisputeUnlockTime: 4_000n,
};

for (const [label, lock] of [
  ["a library-built lock", buildMasumiLockDatum(lockInput)],
  ["a Payment-Service-shaped lock", buildMasumiLockDatum({ ...lockInput, buyerReturnAddress: buyer.sellerAddress, collateralReturnLovelace: 1_435_230n })],
] as const) {
  test(`submitResult datum changes only result_hash, seller cooldown, state (${label})`, () => {
    const before = parseMasumiLockDatum(lock)!;
    const next = submitResultDatum(lock, "44".repeat(32), 9_999n);
    const after = parseMasumiLockDatum(Data.toCBORHex(next))!;
    assert.ok(before && after);
    assert.deepEqual({ ...after, resultHash: before.resultHash, sellerCooldownTime: before.sellerCooldownTime, state: before.state }, before);
    assert.equal(after.resultHash, "44".repeat(32));
    assert.equal(after.sellerCooldownTime, 9_999n);
    assert.equal(after.state, 1n);
  });
}
