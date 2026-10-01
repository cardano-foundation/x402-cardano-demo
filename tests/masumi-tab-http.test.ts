import { strict as assert } from "node:assert";
import { test } from "node:test";
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { decodeX402Headers, logExchange, recordingApi, stepOf, type HttpExchange } from "../frontend/src/masumi/http.ts";

test("the recorder captures the exchange and hands the flow an untouched response", async () => {
  const exchanges: HttpExchange[] = [];
  const api = recordingApi(async () => new Response(JSON.stringify({ ok: true }), { status: 402, statusText: "Payment Required",
    headers: { "Content-Type": "application/json", "PAYMENT-REQUIRED": "abc", "X-Other": "hidden" } }), e => exchanges.push(e));
  const response = await api("/x402/start_job", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ a: 1 }) });
  assert.deepEqual(await response.json(), { ok: true }, "the flow can still read the body");
  assert.equal(exchanges.length, 2, "pending, then answered");
  const e = exchanges[1];
  assert.equal(e.method, "POST");
  assert.equal(e.path, "/x402/start_job");
  assert.deepEqual(e.requestBody, { a: 1 });
  assert.equal(e.status, 402);
  assert.equal(e.statusText, "Payment Required");
  assert.equal(e.responseHeaders["payment-required"], "abc");
  assert.equal(e.responseHeaders["x-other"], undefined, "only the relevant headers");
  assert.deepEqual(e.responseBody, { ok: true });
});

test("a network error is recorded and still thrown to the flow", async () => {
  const exchanges: HttpExchange[] = [];
  const api = recordingApi(async () => { throw new TypeError("Failed to fetch"); }, e => exchanges.push(e));
  await assert.rejects(api("/jobs/by-tx/ab"), /Failed to fetch/);
  assert.equal(exchanges.at(-1)!.error, "Failed to fetch");
  assert.equal(exchanges.at(-1)!.pending, false);
});

test("stepOf maps requests by kind and polls by the status they report", () => {
  const ex = (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) => ({ method, path, requestHeaders: headers, responseBody: body }) as HttpExchange;
  assert.equal(stepOf(ex("POST", "/x402/start_job")), "request");
  assert.equal(stepOf(ex("POST", "/x402/start_job/ada")), "request");
  assert.equal(stepOf(ex("POST", "/x402/start_job", { "PAYMENT-SIGNATURE": "x" })), "pay");
  assert.equal(stepOf(ex("GET", `/jobs/by-tx/${"ab".repeat(32)}`)), "lock");
  assert.equal(stepOf(ex("GET", `/jobs/by-tx/${"ab".repeat(32)}`, {}, { status: "running" })), "lock");
  assert.equal(stepOf(ex("GET", `/jobs/by-tx/${"ab".repeat(32)}`, {}, { status: "completed" })), "result");
  assert.equal(stepOf(ex("POST", "/sokosumi/hire")), "hire");
  assert.equal(stepOf(ex("GET", "/sokosumi/jobs/job-1", {}, { status: "payment_pending" })), "pay");
  assert.equal(stepOf(ex("GET", "/sokosumi/jobs/job-1", {}, { status: "processing" })), "work");
  assert.equal(stepOf(ex("GET", "/sokosumi/jobs/job-1", {}, { status: "completed" })), "done");
  assert.equal(stepOf(ex("GET", "/sokosumi/jobs/job-1", {}, { status: "failed" })), "work");
  assert.equal(stepOf(ex("GET", "/demo/config")), undefined);
});

test("a request still in flight is reported as pending, then replaced by its result", async () => {
  const exchanges: HttpExchange[] = [];
  let release!: () => void;
  const api = recordingApi(() => new Promise<Response>(resolve => { release = () => resolve(new Response("{}", { status: 200 })); }), e => exchanges.push(e), "/api");
  const call = api("/x402/start_job", { method: "POST", headers: { "PAYMENT-SIGNATURE": "sig" }, body: "{}" });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(exchanges.length, 1);
  assert.equal(exchanges[0].pending, true);
  assert.equal(exchanges[0].requestHeaders["PAYMENT-SIGNATURE"], "sig");
  assert.equal(exchanges[0].url, "/api/x402/start_job", "the URL the browser really requests");
  assert.equal(stepOf(exchanges[0]), "pay");
  release(); await call;
  assert.equal(exchanges.length, 2);
  assert.equal(exchanges[1].id, exchanges[0].id);
  assert.equal(exchanges[1].pending, false);
  assert.equal(exchanges[1].status, 200);
});

test("the three x402 headers decode", () => {
  const required = { x402Version: 2, resource: { url: "u" }, accepts: [] };
  const receipt = { success: true, transaction: "ab", network: "cardano:preprod" };
  const decoded = decodeX402Headers({ "payment-required": encodePaymentRequiredHeader(required as never), "payment-response": encodePaymentResponseHeader(receipt as never) });
  assert.deepEqual(decoded["payment-required"], required);
  assert.deepEqual(decoded["payment-response"], receipt);
  assert.match(String(decodeX402Headers({ "payment-signature": "not base64 json" })["payment-signature"]), /could not decode/);
});

test("logExchange replaces a pending report by id and counts only new requests", () => {
  const ex = (id: number, pending: boolean) => ({ id, pending, method: "GET", path: "/p", url: "/p", requestHeaders: {}, responseHeaders: {}, at: 0 }) as HttpExchange;
  let log = logExchange(undefined, ex(1, true));
  log = logExchange(log, ex(1, false));
  assert.equal(log.count, 1);
  assert.equal(log.first.pending, false, "the first entry is replaced too");
  log = logExchange(log, ex(2, false));
  assert.equal(log.count, 2);
  assert.equal(log.latest.id, 2);
  assert.equal(log.first.id, 1);
});
