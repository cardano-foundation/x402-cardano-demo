import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildMasumiLockDatum, parseMasumiLockDatum, toMasumiSellerSigner } from "@x402/cardano";
import { datumRows, displayable, updateStep, type Step } from "../frontend/src/masumi/steps.ts";

test("displayable turns bigints into strings, recursively, without touching other values", () => {
  assert.deepEqual(displayable({ a: 1n, b: [2n, "x", { c: 3n }], d: null, e: true }), { a: "1", b: ["2", "x", { c: "3" }], d: null, e: true });
});

test("datumRows labels all 19 vested_pay fields in on-chain order, with who decides each", () => {
  const mnemonic = "test test test test test test test test test test test junk";
  const seller = toMasumiSellerSigner({ network: "cardano:preprod", mnemonic });
  const buyer = toMasumiSellerSigner({ network: "cardano:preprod", accountIndex: 1, mnemonic });
  const view = parseMasumiLockDatum(buildMasumiLockDatum({
    buyerAddress: buyer.sellerAddress, sellerAddress: seller.sellerAddress, referenceKey: "a4".repeat(20), referenceSignature: "84".repeat(40),
    sellerNonce: "11".repeat(32), buyerNonce: "22".repeat(10), agentIdentifier: "", collateralReturnLovelace: 0n, inputHash: "33".repeat(32),
    payByTime: 1_000n, submitResultTime: 2_000n, unlockTime: 3_000n, externalDisputeUnlockTime: 4_000n,
  }))!;
  const rows = datumRows(view);
  assert.equal(rows.length, 19);
  assert.deepEqual(rows.map(r => r.index), [...Array(19).keys()]);
  assert.equal(rows[0].field, "buyer");
  assert.equal(rows[18].field, "state");
  assert.equal(rows[18].value, "0 (FundsLocked)");
  assert.equal(rows.find(r => r.field === "seller")!.decidedBy, "seller");
  assert.equal(rows.find(r => r.field === "collateral_return_lovelace")!.decidedBy, "buyer");
  assert.equal(rows.find(r => r.field === "result_hash")!.value, "(empty)");
  for (const row of rows) assert.ok(row.meaning.length > 10, `${row.field} has an explanation`);
});

test("updateStep patches one step and leaves the others untouched", () => {
  const steps: Step[] = [
    { id: "a", title: "A", actor: "buyer", explain: "x", status: "done" },
    { id: "b", title: "B", actor: "agent", explain: "y", status: "active" },
  ];
  const next = updateStep(steps, "b", { status: "done", data: { ok: 1n } });
  assert.equal(next[1].status, "done");
  assert.deepEqual(next[1].data, { ok: 1n });
  assert.equal(next[0], steps[0]);
  assert.notEqual(next, steps);
});
