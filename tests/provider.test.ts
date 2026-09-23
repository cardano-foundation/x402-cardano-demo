import assert from "node:assert/strict";
import { test } from "node:test";
import { x402Client } from "@x402/core/client";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { ExactCardanoScheme } from "@x402/cardano/exact/client";
import { buildMasumiLock, decodeCardanoTransaction, ERR_CHAIN_LOOKUP_FAILED, minUtxoLovelace, USDM_PREPROD_ASSET, validateMasumiExtra } from "@x402/cardano";
import { Data } from "@evolution-sdk/evolution";
import { providerFixture } from "./provider-fixture.ts";
import { createFixture } from "./fixtures.ts";
import { confirmExpiry } from "../facilitator/src/settlement.ts";

const methods = [
  { path: "/api/message", asset: "lovelace", amount: "2000000", escrow: false },
  { path: "/api/message-usdm", asset: USDM_PREPROD_ASSET, amount: "100000", escrow: false },
  { path: "/api/message-masumi", asset: "lovelace", amount: "5000000", escrow: true },
  { path: "/api/message-masumi-usdm", asset: USDM_PREPROD_ASSET, amount: "250000", escrow: true },
];

for (const method of methods) for (const initiallyPending of [false, true]) {
  test(`production CIP-30 and HTTP Blockfrost adapters ${initiallyPending ? "resume pending" : "settle"} and replay ${method.path}`, async t => {
    const fixture = await providerFixture(t);
    if (initiallyPending) fixture.state.confirmations = -1;
    const client = x402Client.fromConfig({ schemes: [{ network: "cardano:preprod", client: new ExactCardanoScheme(fixture.signer) }],
      spendControls: { allowedAssets: [{ network: "cardano:preprod", asset: method.asset, maxAmountPerPayment: method.amount }] } });
    const url = `${fixture.origin}${method.path}?requestId=provider&confirmations=1`;
    const quote = await fetch(url);
    assert.equal(quote.status, 402);
    const required = decodePaymentRequiredHeader(quote.headers.get("PAYMENT-REQUIRED")!);
    const payload = await client.createPaymentPayload(required);
    const transaction = String(payload.payload.transaction);
    const decoded = decodeCardanoTransaction(transaction);
    const output = decoded.outputs.find(output => output.address === required.accepts[0].payTo)!;
    assert.ok(output);
    if (method.asset !== "lovelace") assert.equal(output.assets[method.asset], BigInt(method.amount));
    if (method.escrow) {
      const schema = validateMasumiExtra(required.accepts[0].extra, "cardano:preprod");
      assert.ok(schema.ok);
      const expected = buildMasumiLock(schema.extra, fixture.payer, method.asset, BigInt(method.amount), 4310n);
      assert.equal(output.coin, expected.lockedLovelace);
      assert.equal(output.datum, Data.toCBORHex(expected.datum.data));
    } else if (method.asset === "lovelace") assert.equal(output.coin, BigInt(method.amount));
    else assert.ok(output.coin >= minUtxoLovelace(output.serializedSize!, 4310n));
    const headers = { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) };
    if (initiallyPending) {
      const pending = await fetch(url, { headers });
      assert.equal(pending.status, 402);
      assert.equal(decodePaymentResponseHeader(pending.headers.get("PAYMENT-RESPONSE")!).errorReason, "settlement_pending");
      assert.equal(fixture.state.submissions.length, 1);
      assert.equal(fixture.state.spent, true);
      assert.equal((await pending.json()).message, undefined);
      fixture.state.confirmations = 1;
    }
    const paid = await fetch(url, { headers });
    assert.equal(paid.status, 200, JSON.stringify({ body: await paid.clone().text(), reason: paid.headers.has("PAYMENT-REQUIRED") ? decodePaymentRequiredHeader(paid.headers.get("PAYMENT-REQUIRED")!).error : null, requests: fixture.state.requests }));
    const receipt = decodePaymentResponseHeader(paid.headers.get("PAYMENT-RESPONSE")!);
    assert.equal(receipt.success, true);
    assert.equal(receipt.transaction, decoded.txHash);
    const body = await paid.json();
    assert.match(body.message, /Hello from x402/);
    assert.equal(fixture.state.signs, 1);
    assert.equal(fixture.state.walletSubmits, 0);
    assert.equal(fixture.state.submissions.length, 1);
    assert.deepEqual(fixture.state.submissions[0], Buffer.from(transaction, "base64"));
    assert.equal(fixture.state.spent, true);
    const replay = await fetch(url, { headers });
    assert.equal(replay.status, 200, await replay.clone().text());
    assert.deepEqual(await replay.json(), body);
    assert.equal(fixture.state.submissions.length, 1);
    assert.equal(fixture.state.signs, 1);
  });
}

test("provider evaluation failure is reported, releases no resource and can retry the same signed payment", async t => {
  const fixture = await providerFixture(t);
  fixture.state.evaluationUnavailable = true;
  const client = x402Client.fromConfig({ schemes: [{ network: "cardano:preprod", client: new ExactCardanoScheme(fixture.signer) }],
    spendControls: { allowedAssets: [{ network: "cardano:preprod", asset: "lovelace", maxAmountPerPayment: "2000000" }] } });
  const url = `${fixture.origin}/api/message?requestId=evaluation-retry&confirmations=1`;
  const quote = await fetch(url);
  const payload = await client.createPaymentPayload(decodePaymentRequiredHeader(quote.headers.get("PAYMENT-REQUIRED")!));
  const headers = { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) };
  const failed = await fetch(url, { headers });
  assert.equal(failed.status, 402);
  assert.equal(decodePaymentRequiredHeader(failed.headers.get("PAYMENT-REQUIRED")!).error, ERR_CHAIN_LOOKUP_FAILED);
  assert.equal((await failed.json()).message, undefined);
  assert.equal(fixture.state.submissions.length, 0);
  fixture.state.evaluationUnavailable = false;
  const retried = await fetch(url, { headers });
  assert.equal(retried.status, 200, await retried.clone().text());
  assert.equal(fixture.state.signs, 1);
  assert.equal(fixture.state.submissions.length, 1);
});

test("ambiguous provider submission failure never pays again and becomes terminal only after expiry", async t => {
  const fixture = await providerFixture(t);
  fixture.state.rejected = true;
  const client = x402Client.fromConfig({ schemes: [{ network: "cardano:preprod", client: new ExactCardanoScheme(fixture.signer) }],
    spendControls: { allowedAssets: [{ network: "cardano:preprod", asset: "lovelace", maxAmountPerPayment: "2000000" }] } });
  const url = `${fixture.origin}/api/message?requestId=submission-failure&confirmations=1`;
  const quote = await fetch(url);
  const payload = await client.createPaymentPayload(decodePaymentRequiredHeader(quote.headers.get("PAYMENT-REQUIRED")!));
  const headers = { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) };
  const failed = await fetch(url, { headers });
  assert.equal(failed.status, 402);
  const receipt = decodePaymentResponseHeader(failed.headers.get("PAYMENT-RESPONSE")!);
  assert.equal(receipt.success, false);
  assert.equal(receipt.errorReason, "exact_cardano_settlement_failed");
  // The published Evolution adapter exposes the operation error, not Blockfrost's
  // response body. A 400 alone is not enough to prove these bytes never landed.
  assert.match(receipt.errorMessage ?? "", /Blockfrost submitTx failed/);
  assert.equal((await failed.json()).message, undefined);
  assert.equal(fixture.state.spent, false);
  const retried = await fetch(url, { headers });
  assert.equal(retried.status, 402);
  assert.equal(decodePaymentResponseHeader(retried.headers.get("PAYMENT-RESPONSE")!).errorReason, "settlement_pending");
  assert.equal(fixture.state.signs, 1);
  assert.equal(fixture.state.submissions.length, 1);
  const now = Date.now.bind(Date);
  t.mock.method(Date, "now", () => now() + 15 * 60_000);
  const expired = await fetch(url, { headers });
  assert.equal(expired.status, 402);
  const terminal = decodePaymentResponseHeader(expired.headers.get("PAYMENT-RESPONSE")!);
  assert.equal(terminal.errorReason, "exact_cardano_settlement_failed");
  assert.equal(terminal.extra?.status, "expired");
  assert.equal((await expired.json()).message, undefined);
  assert.equal(fixture.state.submissions.length, 1);
});

test("provider outage after TTL cannot expire a confirmed payment and recovery returns its resource", async t => {
  const fixture = await providerFixture(t);
  fixture.state.confirmations = -1;
  const client = x402Client.fromConfig({ schemes: [{ network: "cardano:preprod", client: new ExactCardanoScheme(fixture.signer) }],
    spendControls: { allowedAssets: [{ network: "cardano:preprod", asset: "lovelace", maxAmountPerPayment: "2000000" }] } });
  const url = `${fixture.origin}/api/message?requestId=provider-outage-after-ttl&confirmations=1`;
  const quote = await fetch(url);
  const payload = await client.createPaymentPayload(decodePaymentRequiredHeader(quote.headers.get("PAYMENT-REQUIRED")!));
  const headers = { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) };
  const first = await fetch(url, { headers });
  assert.equal(first.status, 402);
  assert.equal(decodePaymentResponseHeader(first.headers.get("PAYMENT-RESPONSE")!).errorReason, "settlement_pending");
  fixture.state.confirmations = 1;
  fixture.state.evidenceUnavailable = true;
  const now = Date.now.bind(Date);
  t.mock.method(Date, "now", () => now() + 15 * 60_000);
  const unavailable = await fetch(url, { headers });
  assert.equal(unavailable.status, 402);
  const uncertain = decodePaymentResponseHeader(unavailable.headers.get("PAYMENT-RESPONSE")!);
  assert.equal(uncertain.errorReason, "settlement_pending");
  assert.notEqual(uncertain.extra?.status, "expired");
  assert.equal((await unavailable.json()).message, undefined);
  fixture.state.evidenceUnavailable = false;
  const recovered = await fetch(url, { headers });
  assert.equal(recovered.status, 200, await recovered.clone().text());
  assert.equal(decodePaymentResponseHeader(recovered.headers.get("PAYMENT-RESPONSE")!).success, true);
  assert.match((await recovered.json()).message, /Hello from x402/);
  assert.equal(fixture.state.signs, 1);
  assert.equal(fixture.state.submissions.length, 1);
});

test("expiry recheck cannot manufacture success from changed or missing evidence", async () => {
  const { chain } = await createFixture();
  const expired = { success: false, errorReason: "exact_cardano_settlement_failed", transaction: "a".repeat(64), network: "cardano:preprod" as const, extra: { status: "expired" } };
  const changed = await confirmExpiry(expired, { ...chain, getTransactionEvidence: async () => ({ status: "confirmed", confirmations: 20 }) });
  assert.equal(changed.success, false);
  assert.equal(changed.errorReason, "settlement_pending");
  assert.equal(changed.extra?.status, "pending");
  const { getTransactionEvidence: _evidence, ...withoutEvidence } = chain;
  const missing = await confirmExpiry(expired, withoutEvidence);
  assert.equal(missing.success, false);
  assert.equal(missing.errorReason, "settlement_pending");
  assert.equal(missing.extra?.status, "pending");
});
