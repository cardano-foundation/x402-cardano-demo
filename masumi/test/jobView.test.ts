import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildMasumiLockDatum, parseMasumiLockDatum, toMasumiSellerSigner } from "@x402/cardano";
import { lockSnapshot, view, type Job } from "../src/jobView.js";
import type { EscrowUtxo } from "../src/lockMatch.js";

const mnemonic = "test test test test test test test test test test test junk";
const seller = toMasumiSellerSigner({ network: "cardano:preprod", mnemonic });
const buyer = toMasumiSellerSigner({ network: "cardano:preprod", accountIndex: 1, mnemonic });
const datum = parseMasumiLockDatum(buildMasumiLockDatum({
  buyerAddress: buyer.sellerAddress, sellerAddress: seller.sellerAddress, referenceKey: "a4".repeat(20), referenceSignature: "84".repeat(40),
  sellerNonce: "11".repeat(32), buyerNonce: "", agentIdentifier: "", collateralReturnLovelace: 0n, inputHash: "33".repeat(32),
  payByTime: 1_000n, submitResultTime: 2_000n, unlockTime: 3_000n, externalDisputeUnlockTime: 4_000n,
}))!;
const utxo: EscrowUtxo = {
  txHash: "ab".repeat(32), outputIndex: 0, datum, lovelace: 5_000_000n, tokens: { u: 1n }, hasReferenceScript: false,
  raw: { transactionId: "not serialisable", big: 1n },
};

test("the job view serialises (no bigints, no raw UTxO) and carries the lock datum and result hash", () => {
  const job: Job = {
    id: "j1", path: "x402", status: "completed", input: { identifier_from_purchaser: "aa".repeat(10), input_data: { text: "hi" } },
    expected: { sellerAddress: seller.sellerAddress, referenceKey: "", referenceSignature: "", sellerNonce: "", buyerNonce: "", agentIdentifier: "",
      inputHash: "", payByTime: 1n, submitResultTime: 2n, unlockTime: 3n, externalDisputeUnlockTime: 4n, unit: "lovelace", amount: 5_000_000n },
    terms: { payByTime: 1000 }, lock: lockSnapshot(utxo), resultHash: "cd".repeat(32), sellerCooldownTime: 9n, resultTx: "ef".repeat(32), result: "IH",
  };
  const json = JSON.stringify(view(job));
  const back = JSON.parse(json);
  assert.equal(back.lock.ref, `${"ab".repeat(32)}#0`);
  assert.equal(back.lock.lovelace, "5000000");
  assert.deepEqual(back.lock.tokens, { u: "1" });
  assert.equal(back.lock.datum.payByTime, "1000");
  assert.equal(back.lock.datum.state, "0");
  assert.equal(back.resultHash, "cd".repeat(32));
  assert.equal(back.sellerCooldownTime, "9");
  assert.ok(!json.includes("not serialisable") && !json.includes('"raw"'), "the raw UTxO never leaves the agent");
  for (const value of Object.values(back.lock.datum)) assert.ok(value === null || typeof value !== "number", "datum values are strings or objects");
});
