import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { decodeCardanoTransaction } from "@x402/cardano";
import { runPaymentFlow, resumePaymentFlow } from "../frontend/src/x402/flow.ts";
import { createFixture, seller } from "./fixtures.ts";

async function setup(t: TestContext, respond: (request: Request, transaction: string) => Response) {
  const fixture = await createFixture();
  const requests: Request[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init); requests.push(request);
    const header = request.headers.get("PAYMENT-SIGNATURE");
    if (!header) return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader({ x402Version: 2, resource: { url: request.url }, accepts: [{ scheme: "exact", network: "cardano:preprod", payTo: seller.sellerAddress, asset: "lovelace", amount: "2000000", maxTimeoutSeconds: 600, extra: { confirmationPolicy: { l1Confirmations: 1 } } }] }) } });
    const payload = decodePaymentSignatureHeader(header);
    return respond(request, decodeCardanoTransaction(String(payload.payload.transaction)).txHash);
  });
  return { ...fixture, requests };
}
function receipt(transaction: string, pending = false) {
  return new Response(JSON.stringify({ message: "paid" }), { status: pending ? 402 : 200, headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader({ success: !pending, ...(pending ? { errorReason: "settlement_pending" } : {}), network: "cardano:preprod", transaction }) } });
}

test("pending retry sends the same URL and header, without building another transaction", async t => {
  let pending = true;
  const ctx = await setup(t, (_request, tx) => receipt(tx, pending));
  const outcome = await runPaymentFlow("http://demo.test", ctx.client, () => {});
  assert.equal(outcome.status, "pending");
  pending = false;
  assert.equal((await resumePaymentFlow(outcome.payment, () => {})).status, "settled");
  assert.equal(ctx.state.builds, 1);
  assert.equal(ctx.requests.length, 3);
  assert.equal(ctx.requests[1].url, ctx.requests[2].url);
  assert.equal(ctx.requests[1].headers.get("PAYMENT-SIGNATURE"), ctx.requests[2].headers.get("PAYMENT-SIGNATURE"));
});

test("a lost paid response retains the signed payment for safe recovery", async t => {
  let disconnected = true;
  const ctx = await setup(t, (_request, tx) => { if (disconnected) throw new Error("Connection lost"); return receipt(tx); });
  const outcome = await runPaymentFlow("http://demo.test", ctx.client, () => {});
  assert.equal(outcome.status, "unknown");
  disconnected = false;
  assert.equal((await resumePaymentFlow(outcome.payment, () => {})).status, "settled");
  assert.equal(ctx.state.builds, 1);
});

for (const pending of [false, true]) {
  test(`a mismatched ${pending ? "pending" : "successful"} receipt cannot confirm this payment`, async t => {
    const ctx = await setup(t, () => receipt("a".repeat(64), pending));
    const outcome = await runPaymentFlow("http://demo.test", ctx.client, () => {});
    assert.equal(outcome.status, "unknown");
    assert.notEqual(outcome.transaction, "a".repeat(64));
  });
}

test("verification errors are decoded from PAYMENT-REQUIRED", async t => {
  const ctx = await setup(t, () => new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader({ x402Version: 2, resource: { url: "http://demo.test/api/message" }, error: "nonce_not_on_chain", accepts: [] }) } }));
  await assert.rejects(runPaymentFlow("http://demo.test", ctx.client, () => {}), /Payment rejected: nonce_not_on_chain/);
});

test("a provider submission error can still mean broadcast, so recovery keeps the payment", async t => {
  const ctx = await setup(t, (_request, transaction) => new Response("{}", { status: 402, headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader({ success: false, errorReason: "exact_cardano_settlement_failed", transaction, network: "cardano:preprod" }) } }));
  const outcome = await runPaymentFlow("http://demo.test", ctx.client, () => {});
  assert.equal(outcome.status, "unknown");
  assert.equal(ctx.state.builds, 1);
});

for (const expired of [false, true]) {
  test(`a matched ${expired ? "expired" : "definitively rejected"} payment permits a fresh attempt`, async t => {
    const ctx = await setup(t, (_request, transaction) => new Response("{}", { status: 402, headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader({ success: false, errorReason: expired ? "exact_cardano_settlement_failed" : "exact_cardano_settlement_definitively_rejected", ...(expired ? { extra: { status: "expired" } } : {}), transaction, network: "cardano:preprod" }) } }));
    const outcome = await runPaymentFlow("http://demo.test", ctx.client, () => {});
    assert.equal(outcome.status, "failed");
  });
}

test("a rejected settlement check reports its verification reason while retaining the original payment", async t => {
  let checking = false;
  const ctx = await setup(t, (request, transaction) => checking
    ? new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader({ x402Version: 2, resource: { url: request.url }, error: "invalid_exact_cardano_payload_ttl_expired", accepts: [] }) } })
    : receipt(transaction, true));
  const pending = await runPaymentFlow("http://demo.test", ctx.client, () => {});
  assert.equal(pending.status, "pending");
  checking = true;
  const result = await resumePaymentFlow(pending.payment, () => {});
  assert.equal(result.status, "unknown");
  assert.match(result.message, /invalid_exact_cardano_payload_ttl_expired/);
  assert.equal(result.payment, pending.payment);
  assert.equal(ctx.state.builds, 1);
  assert.equal(ctx.requests[2].headers.get("PAYMENT-SIGNATURE"), ctx.requests[1].headers.get("PAYMENT-SIGNATURE"));
});

test("automatic checks complete pending settlement using the same signature", async t => {
  let calls = 0;
  const ctx = await setup(t, (_request, transaction) => receipt(transaction, ++calls < 3));
  const result = await runPaymentFlow("http://demo.test", ctx.client, () => {}, "default", { automaticChecks: 3, retryDelayMs: 0 });
  assert.equal(result.status, "settled");
  assert.equal(calls, 3);
  assert.equal(ctx.state.builds, 1);
  assert.equal(new Set(ctx.requests.slice(1).map(request => request.headers.get("PAYMENT-SIGNATURE"))).size, 1);
});

test("automatic checks have a limit and retain a pending payment when exhausted", async t => {
  let calls = 0;
  const ctx = await setup(t, (_request, transaction) => { calls++; return receipt(transaction, true); });
  const result = await runPaymentFlow("http://demo.test", ctx.client, () => {}, "default", { automaticChecks: 2, retryDelayMs: 0 });
  assert.equal(result.status, "pending");
  assert.equal(calls, 3);
  assert.equal(ctx.state.builds, 1);
  assert.match(result.message, /automatic checks/i);
});

test("automatic checks recover a lost response without another signature", async t => {
  let calls = 0;
  const ctx = await setup(t, (_request, transaction) => { if (++calls === 1) throw new Error("Lost response"); return receipt(transaction); });
  const result = await runPaymentFlow("http://demo.test", ctx.client, () => {}, "default", { automaticChecks: 3, retryDelayMs: 0 });
  assert.equal(result.status, "settled");
  assert.equal(calls, 2);
  assert.equal(ctx.state.builds, 1);
  assert.equal(ctx.requests[1].headers.get("PAYMENT-SIGNATURE"), ctx.requests[2].headers.get("PAYMENT-SIGNATURE"));
});

test("automatic checking stops immediately for a mismatched receipt", async t => {
  let calls = 0;
  const ctx = await setup(t, () => { calls++; return receipt("a".repeat(64)); });
  const result = await runPaymentFlow("http://demo.test", ctx.client, () => {}, "default", { automaticChecks: 3, retryDelayMs: 0 });
  assert.equal(result.status, "unknown");
  assert.equal(calls, 1);
  assert.equal(ctx.state.builds, 1);
});

test("automatic checking stops on definitive expiry and never builds a replacement", async t => {
  let calls = 0;
  const ctx = await setup(t, (_request, transaction) => ++calls === 1 ? receipt(transaction, true) : new Response("{}", {
    status: 402, headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader({ success: false, errorReason: "exact_cardano_settlement_failed", extra: { status: "expired" }, transaction, network: "cardano:preprod" }) },
  }));
  const result = await runPaymentFlow("http://demo.test", ctx.client, () => {}, "default", { automaticChecks: 3, retryDelayMs: 0 });
  assert.equal(result.status, "failed");
  assert.equal(calls, 2);
  assert.equal(ctx.state.builds, 1);
});

test("exhausted checks retain the original provider failure instead of hiding it behind pending", async t => {
  let calls = 0;
  const ctx = await setup(t, (_request, transaction) => ++calls > 1 ? receipt(transaction, true) : new Response("{}", {
    status: 402, headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader({ success: false, errorReason: "exact_cardano_settlement_failed", errorMessage: "Blockfrost submitTx failed", transaction, network: "cardano:preprod" }) },
  }));
  const result = await runPaymentFlow("http://demo.test", ctx.client, () => {}, "default", { automaticChecks: 2, retryDelayMs: 0 });
  assert.equal(result.status, "pending");
  assert.match(result.message, /Blockfrost submitTx failed/);
  assert.equal(calls, 3);
  assert.equal(ctx.state.builds, 1);
});

test("a malformed receipt cannot release a payment or enable a replacement", async t => {
  const ctx = await setup(t, (_request, transaction) => new Response("{}", { status: 402, headers: {
    "PAYMENT-RESPONSE": Buffer.from(JSON.stringify({ success: "false", errorReason: "exact_cardano_settlement_failed", extra: { status: "expired" }, transaction, network: "cardano:preprod" })).toString("base64"),
  } }));
  const result = await runPaymentFlow("http://demo.test", ctx.client, () => {}, "default", { automaticChecks: 3, retryDelayMs: 0 });
  assert.equal(result.status, "unknown");
  assert.match(result.message, /invalid receipt/);
  assert.equal(ctx.requests.length, 2);
  assert.equal(ctx.state.builds, 1);
});

test("pending receipts explain when a provider outage prevents confirming expiry", async t => {
  const ctx = await setup(t, (_request, transaction) => new Response("{}", { status: 402, headers: {
    "PAYMENT-RESPONSE": encodePaymentResponseHeader({ success: false, errorReason: "settlement_pending", errorMessage: "The transaction lookup is unavailable, so expiry cannot be confirmed", transaction, network: "cardano:preprod" }),
  } }));
  const result = await runPaymentFlow("http://demo.test", ctx.client, () => {});
  assert.equal(result.status, "pending");
  assert.match(result.message, /expiry cannot be confirmed/);
  assert.equal(ctx.state.builds, 1);
});
