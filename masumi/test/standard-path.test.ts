/**
 * A Sokosumi hire, replayed offline: our `start_job` response body goes through
 * Sokosumi's parsing and forwarding and the Payment Service's `/purchase`
 * checks (ported in ./vendor, sharing no code with src/).
 */
import { strict as assert } from "node:assert";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { toMasumiSellerSigner } from "@x402/cardano";
import stringify from "canonical-json";
import LZString from "lz-string";
import { ESCROW_ADDRESS, TUSDM_UNIT } from "../src/constants.js";
import { inputHash, registryMetadata, standardTerms } from "../src/masumi.js";
import { sokosumiPurchaseBody, verifyPurchase } from "./vendor/paymentServiceVerifier.js";

const seller = toMasumiSellerSigner({ network: "cardano:preprod", mnemonic: "test test test test test test test test test test test junk" });
const agentIdentifier = "67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b" + "10" + "cd".repeat(28) + "000000";
const price = 1_000_000n;
const onchainMetadata = JSON.parse(JSON.stringify(registryMetadata({
  name: "Demo", description: "Demo agent", apiBaseUrl: "https://agent.example.com", authorName: "Demo",
  tags: ["demo"], image: "ipfs://demo", priceUnits: price,
})));
const chain = { nftHolderAddress: seller.sellerAddress, onchainMetadata, smartContractAddress: ESCROW_ADDRESS, network: "Preprod" as const };
const amounts = [{ amount: price.toString(), unit: TUSDM_UNIT }];
const identifierFromPurchaser = randomBytes(10).toString("hex"); // Sokosumi: 20 hex characters
const inputData = { text: "hello masumi" };

/** What the agent's HTTP handler returns, round-tripped through JSON. */
async function startJobBody(sign = seller.signTerms) {
  const terms = await standardTerms({ identifierFromPurchaser, inputData, agentIdentifier, sellerAddress: seller.sellerAddress, sign });
  return JSON.parse(JSON.stringify({ id: "job-1", status: "awaiting_payment", ...terms.response }));
}
const purchase = (body: unknown) => sokosumiPurchaseBody(body, { agentIdentifier, identifierFromPurchaser, amounts });

test("start_job response passes Payment Service purchase validation", async () => {
  const body = await startJobBody();
  assert.equal(body.input_hash, inputHash(identifierFromPurchaser, inputData));
  const locked = await verifyPurchase(purchase(body), chain);
  assert.equal(locked.buyerNonce, identifierFromPurchaser);
  assert.match(locked.sellerNonce, /^[0-9a-f]{64}$/);
});

test("a price that differs from the registry is rejected", async () => {
  await assert.rejects(verifyPurchase({ ...purchase(await startJobBody()), Amounts: [{ amount: "1", unit: TUSDM_UNIT }] }, chain), /Amounts do not match/);
});

test("a different NFT holder address (same key, no stake part) is rejected", async () => {
  const enterprise = toMasumiSellerSigner({ network: "cardano:preprod", mnemonic: "test test test test test test test test test test test junk" });
  const { Address } = await import("@evolution-sdk/evolution");
  const base = Address.fromBech32(enterprise.sellerAddress);
  assert.ok(base.stakingCredential, "the seller address is a base address");
  const withoutStake = Address.toBech32(new Address.Address({ networkId: base.networkId, paymentCredential: base.paymentCredential }));
  await assert.rejects(verifyPurchase(purchase(await startJobBody()), { ...chain, nftHolderAddress: withoutStake }), /signature invalid/);
});

test("a wrong identifierFromPurchaser echo is rejected by Sokosumi", async () => {
  const body = { ...(await startJobBody()), identifierFromPurchaser: "ff".repeat(10) };
  assert.throws(() => purchase(body), /different purchaser identifier/);
});

/**
 * A buggy agent that signs a payload drifting from the Payment Service's.
 * The verifier must reject every drift, otherwise the test above proves nothing.
 */
async function driftedBody(drift: (payload: Record<string, unknown>) => void) {
  const now = Date.now();
  const times = { payByTime: now + 15 * 60_000, submitResultTime: now + 40 * 60_000, unlockTime: now + 60 * 60_000, externalDisputeUnlockTime: now + 80 * 60_000 };
  const hash = inputHash(identifierFromPurchaser, inputData);
  const sellerIdentifier = randomBytes(32).toString("hex") + agentIdentifier;
  const payload: Record<string, unknown> = {
    inputHash: hash, agentIdentifier, purchaserIdentifier: identifierFromPurchaser, sellerIdentifier, RequestedFunds: null,
    payByTime: String(times.payByTime), submitResultTime: String(times.submitResultTime), unlockTime: String(times.unlockTime),
    externalDisputeUnlockTime: String(times.externalDisputeUnlockTime), sellerAddress: seller.sellerAddress,
    sellerReturnAddress: null, smartContractAddress: ESCROW_ADDRESS, supportedPaymentSourceIndex: 0,
  };
  drift(payload);
  const { key, signature } = await seller.signTerms(seller.sellerAddress, createHash("sha256").update(stringify(payload)).digest("hex"));
  const blockchainIdentifier = Buffer.from(LZString.compressToUint8Array([sellerIdentifier, identifierFromPurchaser, signature, key, ESCROW_ADDRESS].join("."))).toString("hex");
  const sellerVKey = (await startJobBody()).sellerVKey;
  return { id: "job-2", ...times, blockchainIdentifier, agentIdentifier, sellerVKey, identifierFromPurchaser, input_hash: hash, paymentSourceType: "Web3CardanoV2", supportedPaymentSourceIndex: 0 };
}

test("the verifier accepts an undrifted payload (control)", async () => {
  await verifyPurchase(purchase(await driftedBody(() => {})), chain);
});

for (const [label, drift] of [
  ["supportedPaymentSourceIndex omitted", (p: Record<string, unknown>) => { delete p.supportedPaymentSourceIndex; }],
  ["sellerReturnAddress set", (p: Record<string, unknown>) => { p.sellerReturnAddress = p.sellerAddress; }],
  ["times signed as numbers", (p: Record<string, unknown>) => { p.payByTime = Number(p.payByTime); }],
  ["RequestedFunds listed for fixed pricing", (p: Record<string, unknown>) => { p.RequestedFunds = [{ amount: "1000000", unit: TUSDM_UNIT }]; }],
] as const) {
  test(`a signed payload with ${label} is rejected`, async () => {
    await assert.rejects(verifyPurchase(purchase(await driftedBody(drift)), chain), /signature invalid/);
  });
}
