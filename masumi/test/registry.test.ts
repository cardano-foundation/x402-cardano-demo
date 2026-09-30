import { strict as assert } from "node:assert";
import { test } from "node:test";
import { toMasumiSellerSigner } from "@x402/cardano";
import { NETWORK, TUSDM_X402_ASSET } from "../src/constants.js";
import { registryMetadata } from "../src/masumi.js";
import { makeRegistryValidator } from "../src/registry.js";

const seller = toMasumiSellerSigner({ network: NETWORK, mnemonic: "test test test test test test test test test test test junk" });
const other = toMasumiSellerSigner({ network: NETWORK, accountIndex: 3, mnemonic: "test test test test test test test test test test test junk" });
const agentIdentifier = "67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b" + "10" + "ef".repeat(28) + "000000";
const metadata = JSON.parse(JSON.stringify(registryMetadata({
  name: "Demo", description: "Demo", apiBaseUrl: "https://agent.example.com", authorName: "Demo", tags: ["demo"], image: "ipfs://x", priceUnits: 1_000_000n,
})));

function validator(holder = seller.sellerAddress, onchain: unknown = metadata) {
  return makeRegistryValidator({ baseUrl: "https://bf", projectId: "p" }, async url => ({
    ok: true, status: 200,
    json: async () => url.endsWith("/addresses") ? [{ address: holder, quantity: "1" }] : { onchain_metadata: onchain },
  }));
}
const claim = {
  agentIdentifier, sellerAddress: seller.sellerAddress, network: NETWORK, amount: "1000000", asset: TUSDM_X402_ASSET,
  resource: { url: "https://agent.example.com/x402/start_job" },
};

test("accepts the matching tUSDM claim (dotted x402 asset vs concatenated metadata unit)", async () => {
  assert.equal(await validator()(claim), true);
});

for (const [label, patch] of [
  ["a different price", { amount: "999999" }],
  ["the library's other tUSDM token", { asset: "e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9.0014df10745553444d" }],
  ["lovelace", { asset: "lovelace" }],
  ["another network", { network: "cardano:mainnet" }],
  ["a resource outside api_base_url", { resource: { url: "https://agent.example.com.evil.io/x402/start_job" } }],
  ["a foreign agent identifier policy", { agentIdentifier: "ab".repeat(28) + agentIdentifier.slice(56) }],
] as const) {
  test(`rejects ${label}`, async () => {
    assert.equal(await validator()({ ...claim, ...patch }), false);
  });
}

test("rejects when another key holds the NFT", async () => {
  assert.equal(await validator(other.sellerAddress)(claim), false);
});

test("rejects metadata whose source is not the Masumi escrow", async () => {
  const bad = structuredClone(metadata);
  bad.supported_payment_sources[0].settlement.address = [other.sellerAddress];
  assert.equal(await validator(seller.sellerAddress, bad)(claim), false);
});

test("rejects when Blockfrost fails", async () => {
  const failing = makeRegistryValidator({ baseUrl: "https://bf", projectId: "p" }, async () => ({ ok: false, status: 500, json: async () => ({}) }));
  assert.equal(await failing(claim), false);
});
