import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { SupportedResponse } from "@x402/core/types";
import { x402Facilitator } from "@x402/core/facilitator";
import { x402Client } from "@x402/core/client";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { ExactCardanoScheme as FacilitatorScheme } from "@x402/cardano/exact/facilitator";
import { ExactCardanoScheme as ClientScheme } from "@x402/cardano/exact/client";
import { createResourceApp } from "../server/src/app.ts";
import { createFixture, seller } from "./fixtures.ts";

async function setup(t: TestContext) {
  const fixture = await createFixture();
  const verificationCalls = { count: 0 };
  const facilitator = new x402Facilitator().register("cardano:preprod", new FacilitatorScheme(fixture.chain, { confirmationTimeoutMs: 10, confirmationPollMs: 1 }));
  const app = await createResourceApp({ facilitator: { getSupported: async () => facilitator.getSupported() as SupportedResponse, verify: (payload, requirements) => { verificationCalls.count++; return facilitator.verify(payload, requirements); }, settle: (payload, requirements) => facilitator.settle(payload, requirements) }, payTo: seller.sellerAddress, masumiSeller: seller });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => listener.once("listening", resolve));
  t.after(() => { listener.closeAllConnections(); listener.close(); });
  const origin = `http://127.0.0.1:${(listener.address() as { port: number }).port}`;
  const client = x402Client.fromConfig({ schemes: [{ network: "cardano:preprod", client: new ClientScheme(fixture.client) }], spendControls: { allowedAssets: [{ network: "cardano:preprod", asset: "lovelace", maxAmountPerPayment: "5000000" }] } });
  async function quote(path = "/api/message?requestId=one&confirmations=1") {
    const response = await fetch(origin + path);
    assert.equal(response.status, 402);
    return decodePaymentRequiredHeader(response.headers.get("PAYMENT-REQUIRED")!);
  }
  async function pay(path: string, header: string) {
    return fetch(origin + path, { headers: { "PAYMENT-SIGNATURE": header } });
  }
  return { ...fixture, verificationCalls, origin, client, signer: fixture.client, quote, pay };
}

test("official packages settle an ADA request and replay returns the same operation", async t => {
  const ctx = await setup(t);
  const path = "/api/message?requestId=one&confirmations=1";
  const required = await ctx.quote(path);
  assert.equal(required.accepts[0].extra?.submissionPolicy, undefined);
  const payload = await ctx.client.createPaymentPayload(required);
  const header = encodePaymentSignatureHeader(payload);
  const paid = await ctx.pay(path, header);
  assert.equal(paid.status, 200, await paid.clone().text());
  assert.equal(decodePaymentResponseHeader(paid.headers.get("PAYMENT-RESPONSE")!).success, true);
  const body = await paid.json();
  const replay = await ctx.pay(path, header);
  assert.deepEqual(await replay.json(), body);
  assert.equal(ctx.state.broadcasts, 1);
  const another = await ctx.pay("/api/message?requestId=another&confirmations=1", header);
  assert.equal(another.status, 402);
  assert.match(decodePaymentRequiredHeader(another.headers.get("PAYMENT-REQUIRED")!).error!, /duplicate/);
});

test("pending retries reuse a transaction and cannot buy a different operation", async t => {
  const ctx = await setup(t); ctx.state.confirmations = -1;
  const path = "/api/message?requestId=pending&confirmations=1";
  const header = encodePaymentSignatureHeader(await ctx.client.createPaymentPayload(await ctx.quote(path)));
  const pending = await ctx.pay(path, header);
  assert.equal(pending.status, 402);
  assert.equal(decodePaymentResponseHeader(pending.headers.get("PAYMENT-RESPONSE")!).errorReason, "settlement_pending");
  assert.equal(ctx.state.broadcasts, 1);
  ctx.state.spent = true; // Real confirmation consumes the wallet inputs.
  ctx.state.confirmations = 1;
  const resumed = await ctx.pay(path, header);
  assert.equal(resumed.status, 200, await resumed.clone().text());
  assert.equal(ctx.state.broadcasts, 1);
});

test("spent input is rejected before broadcast or resource delivery", async t => {
  const ctx = await setup(t);
  const path = "/api/message?requestId=spent&confirmations=1";
  const header = encodePaymentSignatureHeader(await ctx.client.createPaymentPayload(await ctx.quote(path)));
  ctx.state.spent = true;
  const response = await ctx.pay(path, header);
  assert.equal(response.status, 402);
  assert.equal(ctx.state.broadcasts, 0);
  assert.equal((await response.json()).message, undefined);
});

test("Masumi uses fresh official quotes and binds each quote to one transaction", async t => {
  const ctx = await setup(t);
  const path = "/api/message-masumi?requestId=escrow&confirmations=1";
  const first = await ctx.quote(path); const second = await ctx.quote(path);
  assert.notDeepEqual(first.accepts[0].extra?.terms, second.accepts[0].extra?.terms);
  const payload = await ctx.client.createPaymentPayload(first);
  const paid = await ctx.pay(path, encodePaymentSignatureHeader(payload));
  assert.equal(paid.status, 200, await paid.clone().text());
  const duplicate = await ctx.client.createPaymentPayload(first);
  const rejected = await ctx.pay(path, encodePaymentSignatureHeader(duplicate));
  assert.equal(rejected.status, 402);
  assert.equal(ctx.state.broadcasts, 1);
});

test("configuration exposes only usable methods and confirmation levels", async t => {
  const ctx = await setup(t);
  const config = await (await fetch(ctx.origin + "/demo/config")).json();
  assert.equal(config.methods.length, 4);
  assert.deepEqual(config.facilitator.l1Confirmations, { minimum: 0, maximum: 20 });
  const bad = await fetch(ctx.origin + "/demo/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ l1Confirmations: -1 }) });
  assert.equal(bad.status, 400);
  const old = await fetch(ctx.origin + "/demo/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ submissionPolicy: "client" }) });
  assert.equal(old.status, 400);
});

test("a Masumi quote cannot be redirected to a different request before first use", async t => {
  const ctx = await setup(t);
  const path = "/api/message-masumi?requestId=original&confirmations=1";
  const payload = await ctx.client.createPaymentPayload(await ctx.quote(path));
  const redirected = await ctx.pay("/api/message-masumi?requestId=redirected&confirmations=1", encodePaymentSignatureHeader(payload));
  assert.equal(redirected.status, 402);
  assert.equal(ctx.state.broadcasts, 0);
});

test("token routes preserve their token amount and include required ADA", async t => {
  const ctx = await setup(t);
  const { USDM_PREPROD_ASSET, decodeCardanoTransaction } = await import("@x402/cardano");
  const client = x402Client.fromConfig({ schemes: [{ network: "cardano:preprod", client: new ClientScheme(ctx.signer) }], spendControls: { allowedAssets: [{ network: "cardano:preprod", asset: USDM_PREPROD_ASSET, maxAmountPerPayment: "250000" }] } });
  for (const [route, amount] of [["/api/message-usdm", "100000"], ["/api/message-masumi-usdm", "250000"]]) {
    const path = `${route}?requestId=token&confirmations=1`;
    const required = await ctx.quote(path);
    assert.equal(required.accepts[0].asset, USDM_PREPROD_ASSET);
    assert.equal(required.accepts[0].amount, amount);
    const payload = await client.createPaymentPayload(required);
    const tx = decodeCardanoTransaction(String(payload.payload.transaction));
    const output = tx.outputs.find(output => output.address === required.accepts[0].payTo)!;
    assert.equal(output.assets[USDM_PREPROD_ASSET], BigInt(amount));
    assert.ok(output.coin > 0n);
    const paid = await ctx.pay(path, encodePaymentSignatureHeader(payload));
    assert.equal(paid.status, 200, await paid.clone().text());
  }
});

test("path aliases cannot bypass settlement and expose a pending resource", async t => {
  const ctx = await setup(t); ctx.state.confirmations = -1;
  const path = "/api/message?requestId=canonical&confirmations=1";
  const header = encodePaymentSignatureHeader(await ctx.client.createPaymentPayload(await ctx.quote(path)));
  assert.equal((await ctx.pay(path, header)).status, 402);
  for (const alias of ["/api/message/", "/API/MESSAGE"]) {
    const response = await ctx.pay(`${alias}?requestId=other&confirmations=1`, header);
    assert.equal(response.status, 404, `Alias ${alias} must not reach the protected handler`);
    assert.ok(!(await response.text()).includes("Hello from x402"));
  }
  const head = await fetch(ctx.origin + path, { method: "HEAD", headers: { "PAYMENT-SIGNATURE": header } });
  assert.equal(head.status, 405);
  assert.equal(ctx.state.broadcasts, 1);
});

for (const route of ["/api/message", "/api/message-usdm", "/api/message-masumi", "/api/message-masumi-usdm"]) {
  test(`${route}: expired unconfirmed payment reaches terminal settlement instead of endless verification rejection`, async t => {
    const ctx = await setup(t); ctx.state.confirmations = -1;
    const { USDM_PREPROD_ASSET } = await import("@x402/cardano");
    const client = x402Client.fromConfig({ schemes: [{ network: "cardano:preprod", client: new ClientScheme(ctx.signer) }], spendControls: { allowedAssets: [
      { network: "cardano:preprod", asset: "lovelace", maxAmountPerPayment: "5000000" },
      { network: "cardano:preprod", asset: USDM_PREPROD_ASSET, maxAmountPerPayment: "250000" },
    ] } });
    const path = `${route}?requestId=expiry&confirmations=1`;
    const header = encodePaymentSignatureHeader(await client.createPaymentPayload(await ctx.quote(path)));
    const first = await ctx.pay(path, header);
    assert.equal(decodePaymentResponseHeader(first.headers.get("PAYMENT-RESPONSE")!).errorReason, "settlement_pending");
    ctx.state.slotOffset = 1200;
    const expired = await ctx.pay(path, header);
    assert.equal(expired.status, 402);
    assert.ok(expired.headers.get("PAYMENT-RESPONSE"), "Expiry must reach settle and return an explicit receipt, not a fresh 402 offer");
    const result = decodePaymentResponseHeader(expired.headers.get("PAYMENT-RESPONSE")!);
    assert.equal(result.errorReason, "exact_cardano_settlement_failed");
    assert.equal(result.extra?.status, "expired");
    assert.equal(ctx.state.builds, 1);
    assert.equal(ctx.state.broadcasts, 1);
  });
}

test("a previously verified request resumes settlement when spent-input evidence is temporarily unavailable", async t => {
  const ctx = await setup(t); ctx.state.confirmations = -1;
  const path = "/api/message?requestId=evidence&confirmations=1";
  const header = encodePaymentSignatureHeader(await ctx.client.createPaymentPayload(await ctx.quote(path)));
  assert.equal((await ctx.pay(path, header)).status, 402);
  ctx.state.spent = true; ctx.state.evidenceUnavailable = true;
  const waiting = await ctx.pay(path, header);
  assert.ok(waiting.headers.get("PAYMENT-RESPONSE"), "A verified retry must reach the SDK's post-broadcast path");
  assert.equal(decodePaymentResponseHeader(waiting.headers.get("PAYMENT-RESPONSE")!).errorReason, "settlement_pending");
  ctx.state.evidenceUnavailable = false; ctx.state.confirmations = 1;
  assert.equal((await ctx.pay(path, header)).status, 200);
  assert.equal(ctx.state.broadcasts, 1);
});

test("verification reuse is bound to the exact payload and operation", async t => {
  const ctx = await setup(t); ctx.state.confirmations = -1;
  const path = "/api/message?requestId=exact&confirmations=1";
  const payload = await ctx.client.createPaymentPayload(await ctx.quote(path));
  const header = encodePaymentSignatureHeader(payload);
  assert.equal((await ctx.pay(path, header)).status, 402);
  assert.equal(ctx.verificationCalls.count, 1);
  assert.equal((await ctx.pay(path, header)).status, 402);
  assert.equal(ctx.verificationCalls.count, 1, "Only an identical verified retry skips the pre-broadcast gate");
  const changed = structuredClone(payload);
  changed.payload.nonce = `${"b".repeat(64)}#0`;
  const rejected = await ctx.pay(path, encodePaymentSignatureHeader(changed));
  assert.equal(ctx.verificationCalls.count, 2);
  assert.equal(rejected.status, 402);
  assert.ok(rejected.headers.has("PAYMENT-REQUIRED"));
  assert.equal((await rejected.json()).message, undefined);
  const redirected = await ctx.pay("/api/message?requestId=different&confirmations=1", header);
  assert.equal(ctx.verificationCalls.count, 3);
  assert.equal(redirected.status, 402);
  assert.equal((await redirected.json()).message, undefined);
  ctx.state.confirmations = 1;
  assert.equal((await ctx.pay(path, header)).status, 200);
  assert.equal(ctx.state.broadcasts, 1);
});

test("concurrent checks return one operation and cannot broadcast twice", async t => {
  const ctx = await setup(t);
  const path = "/api/message?requestId=concurrent&confirmations=1";
  const header = encodePaymentSignatureHeader(await ctx.client.createPaymentPayload(await ctx.quote(path)));
  const responses = await Promise.all(Array.from({ length: 4 }, () => ctx.pay(path, header)));
  const bodies = [];
  for (const response of responses) {
    assert.equal(response.status, 200);
    bodies.push(await response.json());
  }
  for (const body of bodies) assert.deepEqual(body, bodies[0]);
  assert.equal(ctx.state.builds, 1);
  assert.equal(ctx.state.broadcasts, 1);
});

test("a confirmed payment still recovers its resource after its signing window expires", async t => {
  const ctx = await setup(t); ctx.state.confirmations = -1;
  const path = "/api/message?requestId=late-recovery&confirmations=1";
  const header = encodePaymentSignatureHeader(await ctx.client.createPaymentPayload(await ctx.quote(path)));
  assert.equal((await ctx.pay(path, header)).status, 402);
  ctx.state.slotOffset = 1200;
  ctx.state.spent = true;
  ctx.state.confirmations = 1;
  const response = await ctx.pay(path, header);
  assert.equal(response.status, 200);
  assert.equal(decodePaymentResponseHeader(response.headers.get("PAYMENT-RESPONSE")!).success, true);
  assert.equal(ctx.state.broadcasts, 1);
});
