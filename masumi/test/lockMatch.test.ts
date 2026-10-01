import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildMasumiLockDatum, parseMasumiLockDatum, toMasumiSellerSigner, type MasumiDatumView } from "@x402/cardano";
import { TUSDM_UNIT, TUSDM_X402_ASSET } from "../src/constants.js";
import { findLock, lockMismatch, type EscrowUtxo, type ExpectedLock } from "../src/lockMatch.js";

const mnemonic = "test test test test test test test test test test test junk";
const seller = toMasumiSellerSigner({ network: "cardano:preprod", mnemonic });
const buyer = toMasumiSellerSigner({ network: "cardano:preprod", accountIndex: 1, mnemonic });

const job: ExpectedLock = {
  sellerAddress: seller.sellerAddress, referenceKey: "a4".repeat(20), referenceSignature: "84".repeat(40),
  sellerNonce: "11".repeat(32), buyerNonce: "22".repeat(10),
  agentIdentifier: "67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b10" + "ab".repeat(28) + "000000",
  inputHash: "33".repeat(32), payByTime: 1_000n, submitResultTime: 2_000n, unlockTime: 3_000n, externalDisputeUnlockTime: 4_000n,
  unit: TUSDM_X402_ASSET, amount: 1_000_000n,
};

/** A lock as a buyer node would create it: the job's terms plus the buyer's own fields. */
const genuineDatum = () => parseMasumiLockDatum(buildMasumiLockDatum({
  ...job, buyerAddress: buyer.sellerAddress, buyerReturnAddress: buyer.sellerAddress, collateralReturnLovelace: 1_435_230n,
}))!;
const utxo = (datum: MasumiDatumView | null, extra: Partial<EscrowUtxo> = {}): EscrowUtxo => ({
  txHash: "ff".repeat(32), outputIndex: 0, datum, lovelace: 3_000_000n, tokens: { [TUSDM_UNIT]: 1_000_000n }, hasReferenceScript: false, ...extra,
});

test("accepts the genuine lock", () => {
  assert.equal(lockMismatch(utxo(genuineDatum()), job), null);
});

const spoofs: Array<[string, Partial<MasumiDatumView>]> = [
  ["seller", { seller: parseMasumiLockDatum(buildMasumiLockDatum({ ...job, buyerAddress: buyer.sellerAddress, sellerAddress: buyer.sellerAddress, collateralReturnLovelace: 0n }))!.seller }],
  ["seller_return_address", { sellerReturnAddress: genuineDatum().buyer }],
  ["reference_key", { referenceKey: "a5".repeat(20) }],
  ["reference_signature", { referenceSignature: "85".repeat(40) }],
  ["seller_nonce", { sellerNonce: "12".repeat(32) }],
  ["buyer_nonce", { buyerNonce: "23".repeat(10) }],
  ["agent_identifier", { agentIdentifier: job.agentIdentifier.replace(/0$/, "1") }],
  ["input_hash", { inputHash: "34".repeat(32) }],
  ["result_hash", { resultHash: "44".repeat(32) }],
  ["pay_by_time", { payByTime: 1_001n }],
  ["submit_result_time", { submitResultTime: 2_001n }],
  ["unlock_time", { unlockTime: 4_102_444_800_000n }],
  ["external_dispute_unlock_time", { externalDisputeUnlockTime: 4_102_444_800_000n }],
  ["seller_cooldown_time", { sellerCooldownTime: 4_102_444_800_000n }],
  ["buyer_cooldown_time", { buyerCooldownTime: 1n }],
  ["state", { state: 1n }],
  ["collateral_return_lovelace", { collateralReturnLovelace: 3_000_001n }],
  ["buyer", { buyer: { ...genuineDatum().buyer, pointer: { slot: 1n, txIndex: 2n, certIndex: 3n } } }],
];
for (const [field, patch] of spoofs) {
  test(`rejects a lock whose ${field} differs`, () => {
    assert.match(lockMismatch(utxo({ ...genuineDatum(), ...patch }), job) ?? "", new RegExp(field));
  });
}

test("rejects underpayment and the wrong token", () => {
  assert.equal(lockMismatch(utxo(genuineDatum(), { tokens: { [TUSDM_UNIT]: 999_999n } }), job), "underpaid");
  assert.equal(lockMismatch(utxo(genuineDatum(), { tokens: { ["e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c90014df10745553444d"]: 1_000_000n } }), job), "underpaid");
});

test("rejects a missing datum, a reference script and, for x402 jobs, another transaction", () => {
  assert.ok(lockMismatch(utxo(null), job));
  assert.ok(lockMismatch(utxo(genuineDatum(), { hasReferenceScript: true }), job));
  assert.ok(lockMismatch(utxo(genuineDatum()), { ...job, txHash: "ee".repeat(32) }));
  assert.equal(lockMismatch(utxo(genuineDatum()), { ...job, txHash: "ff".repeat(32) }), null);
});

test("a spoof seen in the same scan does not shadow the genuine lock", () => {
  const spoof = utxo({ ...genuineDatum(), sellerCooldownTime: 4_102_444_800_000n }, { txHash: "01".repeat(32) });
  const genuine = utxo(genuineDatum(), { txHash: "02".repeat(32) });
  assert.equal(findLock([spoof, genuine], job)?.txHash, "02".repeat(32));
  assert.equal(findLock([spoof], job), undefined);
});

// ---------------------------------------------------------------- tADA offer (unlisted, no agent identifier)

const adaJob: ExpectedLock = { ...job, agentIdentifier: "", unit: "lovelace", amount: 5_000_000n, txHash: "aa".repeat(32) };
const adaDatum = (collateralReturnLovelace: bigint) => parseMasumiLockDatum(buildMasumiLockDatum({
  ...adaJob, buyerAddress: buyer.sellerAddress, collateralReturnLovelace,
}))!;
const adaLock = (lovelace: bigint, collateral = 1_435_230n, tokens: Record<string, bigint> = {}) =>
  utxo(adaDatum(collateral), { txHash: "aa".repeat(32), lovelace, tokens });

test("tADA: accepts a lock paying the price on top of the collateral return", () => {
  assert.equal(lockMismatch(adaLock(6_435_230n), adaJob), null);
});

test("tADA: rejects a lock whose lovelace minus collateral return is below the price", () => {
  assert.equal(lockMismatch(adaLock(6_435_229n), adaJob), "underpaid");
});

test("tADA and tUSDM jobs are not interchangeable", () => {
  // A tUSDM-paying lock with little ADA does not pay a tADA job...
  assert.equal(lockMismatch(adaLock(2_000_000n, 1_435_230n, { [TUSDM_UNIT]: 5_000_000n }), adaJob), "underpaid");
  // ...and an ADA-only lock does not pay a tUSDM job.
  assert.equal(lockMismatch(utxo(genuineDatum(), { lovelace: 50_000_000n, tokens: {} }), job), "underpaid");
});
