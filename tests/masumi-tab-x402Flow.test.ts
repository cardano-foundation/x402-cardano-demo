/**
 * The UI's x402 flow, driven without a browser or wallet: a fake agent (402,
 * paid POST, job polling), a stub signer and an instant clock.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { ESCROW_ADDRESS, TUSDM_X402_ASSET } from "../masumi/src/constants.ts";
import { runX402, type Offer, type X402Deps, type X402StepId } from "../frontend/src/masumi/x402Flow.ts";
import type { Step } from "../frontend/src/masumi/steps.ts";

const ada: Offer = { path: "/x402/start_job/ada", amount: "5000000", asset: "lovelace", resource: "http://agent/x402/start_job/ada", registered: false };
const accept = (asset: string, amount: string) => ({
  scheme: "exact", network: "cardano:preprod", payTo: ESCROW_ADDRESS, asset, amount, maxTimeoutSeconds: 300,
  extra: { assetTransferMethod: "masumi", terms: { payByTime: "1000000" } },
});
const required = { x402Version: 2, resource: { url: ada.resource }, accepts: [accept(TUSDM_X402_ASSET, "1000000"), accept("lovelace", "5000000")] };

type JobReply = { status: number; body?: unknown } | "network-error";
function harness(opts: { paid?: () => Response | Promise<Response>; jobs: JobReply[]; clock?: number[]; signerFails?: string }) {
  const events: Array<[X402StepId, Partial<Step>]> = [];
  const signed: Array<{ asset: string; amount: string }> = [];
  let jobCalls = 0, t = 0;
  const deps: X402Deps = {
    api: async (path, init) => {
      if (path.startsWith("/jobs/by-tx/")) {
        const reply = opts.jobs[Math.min(jobCalls++, opts.jobs.length - 1)];
        if (reply === "network-error") throw new TypeError("Failed to fetch");
        return new Response(reply.body === undefined ? "{}" : JSON.stringify(reply.body), { status: reply.status });
      }
      const paid = new Headers(init?.headers).get("PAYMENT-SIGNATURE");
      if (!paid) return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required as never) } });
      return opts.paid ? opts.paid() : new Promise<Response>(() => {}); // default: the paid request never answers
    },
    createSigner: async context => ({
      getAddress: () => "addr_test1",
      buildAndSignPaymentTransaction: async input => {
        signed.push({ asset: input.asset, amount: input.amount });
        context.onVerified({ termsDigest: "d".repeat(64), registry: "skipped" });
        if (opts.signerFails) throw new Error(opts.signerFails);
        context.onBuilt({ nonce: `${"0".repeat(64)}#0`, output: { lovelace: "5000000", asset: input.asset, amount: input.amount }, datum: null, validTo: "1000000" });
        return { transaction: "AA==", nonce: `${"0".repeat(64)}#0` };
      },
    }),
    emit: (id, patch) => events.push([id, patch]),
    sleep: async () => {},
    now: () => (opts.clock ? opts.clock[Math.min(t++, opts.clock.length - 1)] : 0),
    txHashOf: () => "ab".repeat(32),
    randomHex: () => "aa".repeat(10),
  };
  return { deps, events, signed, last: (id: X402StepId) => events.filter(([s]) => s === id).map(([, p]) => p).reduce((a, b) => ({ ...a, ...b }), {} as Partial<Step>) };
}

test("the offer filter signs only the chosen asset and price", async () => {
  const h = harness({ jobs: [{ status: 200, body: { id: "j", status: "completed", result: "IH", resultTx: "cd".repeat(32) } }] });
  await runX402(ada, "hi", h.deps);
  assert.deepEqual(h.signed, [{ asset: "lovelace", amount: "5000000" }]);
});

test("completed: resolves with the job, fills the result and collect steps", async () => {
  const h = harness({ jobs: [
    { status: 404 },
    { status: 200, body: { id: "j", status: "running", lock: { ref: "x#0", lovelace: "5000000", tokens: {}, datum: {} } } },
    { status: 200, body: { id: "j", status: "completed", result: "IH", resultTx: "cd".repeat(32), resultHash: "ef".repeat(32), unlockTime: 5 } },
  ] });
  const job = await runX402(ada, "hi", h.deps);
  assert.equal(job.result, "IH");
  assert.equal(h.last("request").status, "done");
  assert.equal(h.last("verify").status, "done");
  assert.equal(h.last("pay").status, "done", "the paid HTTP request is its own step");
  assert.ok((h.last("pay").data as { paymentSignature?: unknown }).paymentSignature, "it carries the PAYMENT-SIGNATURE payload");
  assert.equal(h.last("lock").status, "done");
  assert.equal(h.last("result").status, "done");
  assert.match(String((h.last("result").data as { state: string }).state), /awaiting confirmation/);
  assert.equal(h.last("collect").status, "done", "collecting is agent-driven and happens later; the run is complete");
});

test("failed: rejects with the job's error and marks the current step failed", async () => {
  const h = harness({ jobs: [{ status: 200, body: { id: "j", status: "failed", error: "No matching escrow lock arrived in time." } }] });
  await assert.rejects(runX402(ada, "hi", h.deps), /No matching escrow lock/);
  assert.equal(h.events.at(-1)![1].status, "failed");
});

test("a rejected paid request ends the flow with the agent's error", async () => {
  const h = harness({ paid: () => new Response("invalid_payment", { status: 402 }), jobs: [{ status: 404 }] });
  await assert.rejects(runX402(ada, "hi", h.deps), /did not accept the payment \(HTTP 402\): invalid_payment/);
});

test("no job by payByTime + 120 s ends with the 'never recorded' message", async () => {
  const h = harness({ jobs: [{ status: 404 }], clock: [0, 1_000_000 + 120_001] });
  await assert.rejects(runX402(ada, "hi", h.deps), /never recorded this payment/);
});

test("the settle step fills from the receipt when it arrives, independently of polling", async () => {
  const receipt = { success: true, transaction: "ab".repeat(32), network: "cardano:preprod" };
  const h = harness({
    paid: () => new Response(JSON.stringify({ id: "j" }), { status: 200, headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader(receipt as never) } }),
    jobs: [{ status: 404 }, { status: 404 }, { status: 200, body: { id: "j", status: "completed", result: "IH" } }],
  });
  await runX402(ada, "hi", h.deps);
  const settle = h.last("settle");
  assert.equal(settle.status, "done");
  assert.deepEqual((settle.data as { receipt: unknown }).receipt, receipt);
});

test("a wallet error after verification fails the sign step, not the verify step", async () => {
  const h = harness({ jobs: [{ status: 404 }], signerFails: "Your wallet holds 0.00 tUSDM" });
  await assert.rejects(runX402(ada, "hi", h.deps), /Your wallet holds/);
  assert.equal(h.last("verify").status, "done");
  assert.equal(h.last("sign").status, "failed");
});

test("the settle step keeps the payment payload next to the receipt", async () => {
  const receipt = { success: true, transaction: "ab".repeat(32), network: "cardano:preprod" };
  const h = harness({
    paid: () => new Response("{}", { status: 200, headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader(receipt as never) } }),
    jobs: [{ status: 404 }, { status: 200, body: { id: "j", status: "completed", result: "IH" } }],
  });
  await runX402(ada, "hi", h.deps);
  const data = h.last("settle").data as { paymentSignature?: unknown; receipt?: unknown };
  assert.ok(data.paymentSignature, "payload still shown");
  assert.deepEqual(data.receipt, receipt);
});

test("a single failed poll does not end a live run", async () => {
  const h = harness({ jobs: ["network-error", { status: 200, body: { id: "j", status: "completed", result: "IH" } }] });
  assert.equal((await runX402(ada, "hi", h.deps)).result, "IH");
});
