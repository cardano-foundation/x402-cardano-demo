import { strict as assert } from "node:assert";
import { test } from "node:test";
import { TUSDM_UNIT, TUSDM_X402_ASSET } from "../masumi/src/constants.ts";
import { assetLabel, formatAmount, formatTime, kindOf, relative, shortMiddle } from "../frontend/src/masumi/format.ts";

const at = Date.UTC(2026, 8, 30, 10, 32, 5); // 30 Sep 2026 10:32:05 UTC

test("times: UTC date plus relative hint; zero means not set", () => {
  assert.equal(formatTime(at, at + 12 * 60_000), "30 Sep 2026, 10:32:05 UTC (12 min ago)");
  assert.equal(formatTime(at, at - 18 * 60_000), "30 Sep 2026, 10:32:05 UTC (in 18 min)");
  assert.equal(formatTime(0, at), "0 (not set)");
});

test("relative time picks sensible units in both directions", () => {
  assert.equal(relative(at, at + 30_000), "just now");
  assert.equal(relative(at, at - 90 * 60_000), "in 1 h 30 min");
  assert.equal(relative(at, at + 3 * 86_400_000), "3 days ago");
});

test("amounts: lovelace as tADA, tUSDM units as tUSDM, unknown tokens raw", () => {
  assert.equal(formatAmount("lovelace", "5000000"), "5.00 tADA");
  assert.equal(formatAmount("lovelace", 1_435_230n), "1.44 tADA");
  assert.equal(formatAmount(TUSDM_X402_ASSET, "1000000"), "1.00 tUSDM");
  assert.equal(formatAmount(TUSDM_UNIT, "250000"), "0.25 tUSDM");
  assert.equal(formatAmount("ab".repeat(28) + "01", "7"), "7 units");
});

test("shortMiddle keeps both ends of long values only", () => {
  assert.equal(shortMiddle("ab".repeat(32), 6), "ababab…ababab");
  assert.equal(shortMiddle("short", 6), "short");
});

test("kindOf classifies the data shapes the flows produce", () => {
  assert.equal(kindOf("payByTime", "1790000000000"), "time");
  assert.equal(kindOf("unlockTime", 1790000000000), "time");
  assert.equal(kindOf("sellerCooldownTime", "0"), "time");
  assert.equal(kindOf("collateralReturnLovelace", "1435230"), "lovelace");
  assert.equal(kindOf("lovelace", "5000000"), "lovelace");
  assert.equal(kindOf("amount", "1000000", { asset: TUSDM_X402_ASSET }), "amount");
  assert.equal(kindOf("txHash", "ab".repeat(32)), "tx");
  assert.equal(kindOf("resultTx", "cd".repeat(32)), "tx");
  assert.equal(kindOf("ref", `${"ab".repeat(32)}#0`), "utxo");
  assert.equal(kindOf("sellerAddress", "addr_test1qq4jrrcfzylccwgqu3su865es52jkf7yzrdu9cw3z84nycnn3zz9lvqj7vs95tej896xkekzkufhpuk64ja7pga2g8ksdf8km4"), "address");
  assert.equal(kindOf("referenceSignature", "84".repeat(40)), "hex");
  assert.equal(kindOf("blockchainIdentifier", "09".repeat(60)), "hex");
  assert.equal(kindOf("status", "completed"), "plain");
  assert.equal(kindOf("amount", "1000000"), "plain");
});

test("kindOf on the real shapes: lock tokens, offers, outputs, receipts, hashes that are not transactions", () => {
  const tokens = { [TUSDM_UNIT]: "1000000" };
  assert.equal(kindOf(TUSDM_UNIT, "1000000", tokens, "tokens"), "amount");
  assert.equal(kindOf("amount", "1000000", { asset: TUSDM_X402_ASSET, amount: "1000000" }), "amount");
  assert.equal(kindOf("amount", "5000000", { lovelace: "6435230", asset: "lovelace", amount: "5000000" }), "amount");
  assert.equal(kindOf("transaction", "ab".repeat(32), { success: true }, "receipt"), "tx");
  for (const key of ["resultHash", "inputHash", "termsDigest", "hash"]) assert.equal(kindOf(key, "cd".repeat(32)), "hex", key);
  assert.equal(kindOf("maxTimeoutSeconds", 300), "plain");
  assert.equal(kindOf("validTo", "1790000000000"), "time");
  assert.equal(formatTime("0", at), "0 (not set)");
});

test("assets read as names: lovelace, Masumi tUSDM (either form), the other tUSDM, unknown tokens", () => {
  assert.equal(assetLabel("lovelace"), "tADA (lovelace)");
  assert.equal(assetLabel(TUSDM_X402_ASSET), "Masumi tUSDM");
  assert.equal(assetLabel(TUSDM_UNIT), "Masumi tUSDM");
  assert.equal(assetLabel("e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9.0014df10745553444d"), "token e675b46e…");
  assert.equal(kindOf("asset", TUSDM_X402_ASSET), "asset");
  assert.equal(kindOf("asset", "lovelace"), "asset");
  assert.equal(kindOf("unit", TUSDM_UNIT), "asset");
});
