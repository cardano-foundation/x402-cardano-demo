/**
 * The server's /masumi routes: a forward to the Masumi agent (no secrets) and
 * the Sokosumi hire proxy, which spends the operator's credits and therefore
 * only answers the local demo frontend. Plan: docs/plans/2026-10-01-masumi-tab.md.
 */
import assert from "node:assert/strict";
import { request as httpRequest, type IncomingHttpHeaders, type OutgoingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import express from "express";
import { x402Facilitator } from "@x402/core/facilitator";
import { ExactCardanoScheme as FacilitatorScheme } from "@x402/cardano/exact/facilitator";
import type { SupportedResponse } from "@x402/core/types";
import { createSokosumi } from "../masumi/src/sokosumi.ts";
import { createResourceApp } from "../server/src/app.ts";
import { masumiOptionsFromEnv, parseFrontendOrigins, sokosumiGuard } from "../server/src/masumi.ts";
import { createFixture, seller } from "./fixtures.ts";

const ORIGIN = "http://localhost:5173";
const HASH = "ab".repeat(32);

interface Reply { status: number; headers: IncomingHttpHeaders; body: string }

function call(port: number, options: { method?: string; path: string; headers?: OutgoingHttpHeaders; body?: string; host?: string | null; origin?: string | string[] | null }): Promise<Reply> {
  const headers: OutgoingHttpHeaders = { ...options.headers };
  if (options.host !== null) headers.host = options.host ?? `127.0.0.1:${port}`;
  if (options.origin !== null) (headers as Record<string, string | string[]>).origin = options.origin ?? ORIGIN;
  if (options.body !== undefined && !Object.keys(headers).some(k => k.toLowerCase() === "content-type")) headers["content-type"] = "application/json";
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method: options.method ?? "GET", path: options.path, headers, setHost: false }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

const listen = (app: express.Express, t: TestContext) => new Promise<number>(resolve => {
  const server = app.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  t.after(() => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }));
});

/** A fake Sokosumi API behind the real client: counts calls, can fail or hang. */
function fakeSokosumi() {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const state = { createStatus: 201, hold: undefined as Promise<void> | undefined };
  const reply = (status: number, data: unknown) => ({ ok: status < 400, status, json: async () => ({ data }), text: async () => JSON.stringify({ data }) });
  const fetch = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(init.body) : undefined });
    if (url.endsWith("/input-schema")) return reply(200, { input_data: [] });
    if (method === "POST") {
      if (state.hold) await state.hold;
      return state.createStatus >= 400 ? reply(state.createStatus, { error: "boom" }) : reply(201, { id: "job-1", status: "payment_pending", result: null, name: "Demo UI: hi", apiKey: "never" });
    }
    return reply(200, { id: "job-1", status: "completed", result: "IH", name: "Demo UI: hi", internal: "hidden" });
  };
  const posts = () => calls.filter(c => c.method === "POST").length;
  return { calls, state, posts, client: createSokosumi({ baseUrl: "https://soko.test/v1", apiKey: "secret-key", agentName: "demo", agentId: "agent-1", fetch }) };
}

/** A fake Masumi agent that records what the server forwards. */
async function fakeAgent(t: TestContext) {
  const seen: Array<{ method: string; path: string; headers: IncomingHttpHeaders; body: unknown }> = [];
  const state = { hang: false, htmlError: false, htmlConfig: false };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { seen.push({ method: req.method, path: req.path, headers: req.headers, body: req.body }); next(); });
  app.get("/availability", (_req, res) => { res.json({ status: "available" }); });
  app.get("/demo/config", (_req, res) => {
    if (state.htmlConfig) { res.type("html").send("<!doctype html><p>not the agent</p>"); return; }
    res.json({ agentIdentifier: "id", offers: [], sokosumi: { enabled: true } });
  });
  for (const path of ["/x402/start_job", "/x402/start_job/ada"]) {
    app.post(path, (req, res) => {
      if (state.hang) return; // never answers
      if (state.htmlError) { res.status(500).type("html").send("<h1>oops</h1>"); return; }
      if (!req.get("PAYMENT-SIGNATURE")) { res.status(402).set("PAYMENT-REQUIRED", `required:${path}`).json({}); return; }
      res.set("PAYMENT-RESPONSE", "receipt").json({ id: "job", path });
    });
  }
  app.get("/jobs/by-tx/:hash", (req, res) => { res.json({ id: "job", lockTx: req.params.hash }); });
  const port = await listen(app, t);
  return { url: `http://127.0.0.1:${port}`, seen, state };
}

async function setup(t: TestContext, options: { sokosumi?: boolean; agentUrl?: string; payMs?: number; maxCredits?: number } = {}) {
  const fixture = await createFixture();
  const facilitator = new x402Facilitator().register("cardano:preprod", new FacilitatorScheme(fixture.chain, { confirmationTimeoutMs: 10, confirmationPollMs: 1 }));
  const soko = fakeSokosumi();
  const agent = await fakeAgent(t);
  const app = await createResourceApp({
    facilitator: { getSupported: async () => facilitator.getSupported() as SupportedResponse, verify: (p, r) => facilitator.verify(p, r), settle: (p, r) => facilitator.settle(p, r) },
    payTo: seller.sellerAddress,
    masumi: {
      agentUrl: options.agentUrl ?? agent.url,
      frontendOrigins: [ORIGIN, "http://127.0.0.1:5173"],
      ...(options.sokosumi === false ? {} : { sokosumi: { client: soko.client, maxCredits: options.maxCredits } }),
      ...(options.payMs ? { timeouts: { payMs: options.payMs } } : {}),
    },
  });
  const port = await listen(app, t);
  return { port, soko, agent };
}

const hire = (port: number, extra: Parameters<typeof call>[1] extends infer O ? Partial<O> : never = {}) =>
  call(port, { method: "POST", path: "/masumi/sokosumi/hire", body: JSON.stringify({ text: "hi" }), ...extra });

// ---------------------------------------------------------------- hire: allowed

test("hire from the frontend origin creates one job and never exposes the key", async t => {
  const { port, soko } = await setup(t);
  const reply = await hire(port);
  assert.equal(reply.status, 201, reply.body);
  assert.equal(soko.posts(), 1);
  assert.equal(reply.headers["access-control-allow-origin"], ORIGIN);
  assert.match(String(reply.headers.vary), /Origin/);
  assert.deepEqual(JSON.parse(reply.body), { id: "job-1", status: "payment_pending", result: null, name: "Demo UI: hi" });
  assert.doesNotMatch(reply.body, /secret-key|never/);
});

test("hire also works with a localhost Host header", async t => {
  const { port } = await setup(t);
  assert.equal((await hire(port, { host: `localhost:${port}` })).status, 201);
});

test("a configured credit cap is sent with the job", async t => {
  const { port, soko } = await setup(t, { maxCredits: 3 });
  assert.equal((await hire(port)).status, 201);
  assert.equal((soko.calls.find(c => c.method === "POST")!.body as { maxCredits?: number }).maxCredits, 3);
});

test("the allowed origin's preflight is answered by the proxy's own CORS", async t => {
  const { port } = await setup(t);
  const reply = await call(port, { method: "OPTIONS", path: "/masumi/sokosumi/hire", headers: { "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
  assert.equal(reply.status, 204);
  assert.equal(reply.headers["access-control-allow-origin"], ORIGIN);
  assert.match(String(reply.headers["access-control-allow-headers"]).toLowerCase(), /content-type/);
});

// ---------------------------------------------------------------- hire: rejected, never reaching Sokosumi

const rejections: Array<[string, Partial<Parameters<typeof call>[1]> | ((port: number) => Partial<Parameters<typeof call>[1]>), number]> = [
  ["no Origin", { origin: null }, 403],
  ["a foreign origin", { origin: "http://evil.example" }, 403],
  ["Origin null", { origin: "null" }, 403],
  ["an origin with a trailing slash", { origin: "http://localhost:5173/" }, 403],
  ["a duplicated Origin header", { origin: [ORIGIN, "http://evil.example"] }, 403],
  ["a rebinding Host", port => ({ host: `evil.example:${port}` }), 403],
  ["a Host with another port", { host: "127.0.0.1:1" }, 403],
  ["X-Forwarded-For", { headers: { "x-forwarded-for": "127.0.0.1" } }, 403],
  ["Forwarded", { headers: { forwarded: "for=127.0.0.1" } }, 403],
  ["X-Forwarded-Host", { headers: { "x-forwarded-host": "localhost:5173" } }, 403],
  ["X-Forwarded-Proto", { headers: { "x-forwarded-proto": "https" } }, 403],
  ["X-Real-IP", { headers: { "x-real-ip": "127.0.0.1" } }, 403],
  ["CF-Connecting-IP (cloudflared)", { headers: { "cf-connecting-ip": "203.0.113.7" } }, 403],
  ["Sec-Fetch-Mode navigate", { headers: { "sec-fetch-mode": "navigate" } }, 403],
  ["Sec-Fetch-Mode no-cors", { headers: { "sec-fetch-mode": "no-cors" } }, 403],
  ["a text/plain body", { headers: { "content-type": "text/plain" } }, 415],
  ["a form body", { headers: { "content-type": "application/x-www-form-urlencoded" }, body: "text=hi" }, 415],
  ["a multipart body", { headers: { "content-type": "multipart/form-data; boundary=x" }, body: "--x--" }, 415],
  ["an empty text", { body: JSON.stringify({ text: "" }) }, 400],
  ["a 501-character text", { body: JSON.stringify({ text: "x".repeat(501) }) }, 400],
  ["a non-string text", { body: JSON.stringify({ text: 5 }) }, 400],
  ["malformed JSON", { body: "{" }, 400],
  ["a body over 4 kB", { body: JSON.stringify({ text: "x".repeat(5000) }) }, 413],
  ["PUT", { method: "PUT" }, 405],
];
for (const [name, extra, status] of rejections) {
  test(`hire with ${name} gets ${status} and spends nothing`, async t => {
    const { port, soko } = await setup(t);
    const reply = await hire(port, typeof extra === "function" ? extra(port) : extra);
    assert.equal(reply.status, status, reply.body);
    assert.equal(reply.headers["access-control-allow-origin"] === "http://evil.example", false);
    assert.equal(soko.calls.length, 0);
  });
}

test("a hire without any Content-Type gets 415", async t => {
  const { port, soko } = await setup(t);
  const reply = await call(port, { method: "POST", path: "/masumi/sokosumi/hire" });
  assert.equal(reply.status, 415);
  assert.equal(soko.calls.length, 0);
});

test("a foreign origin's preflight is refused before the global CORS can allow it", async t => {
  const { port, soko } = await setup(t);
  const reply = await call(port, { method: "OPTIONS", path: "/masumi/sokosumi/hire", origin: "http://evil.example", headers: { "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
  assert.equal(reply.status, 403);
  assert.equal(reply.headers["access-control-allow-origin"], undefined);
  assert.equal(soko.calls.length, 0);
});

test("path variants never reach Sokosumi from a foreign origin", async t => {
  const { port, soko } = await setup(t);
  for (const path of ["/MASUMI/sokosumi/hire", "/masumi/sokosumi/hire/", "/masumi/SOKOSUMI/hire"]) {
    const reply = await call(port, { method: "POST", path, origin: "http://evil.example", body: JSON.stringify({ text: "hi" }) });
    assert.ok(reply.status === 403 || reply.status === 404, `${path}: ${reply.status}`);
  }
  assert.equal(soko.calls.length, 0);
});

test("a failed create is reported once and never retried", async t => {
  const { port, soko } = await setup(t);
  soko.state.createStatus = 500;
  const reply = await hire(port);
  assert.equal(reply.status, 502);
  assert.equal(soko.posts(), 1);
});

test("a second hire while one is in flight gets 409", { timeout: 10_000 }, async t => {
  const { port, soko } = await setup(t);
  let release!: () => void;
  soko.state.hold = new Promise(resolve => { release = resolve; });
  const first = hire(port);
  while (soko.posts() === 0) await new Promise(resolve => setTimeout(resolve, 5));
  const second = await hire(port);
  assert.equal(second.status, 409);
  release();
  assert.equal((await first).status, 201);
  assert.equal(soko.posts(), 1);
});

// ---------------------------------------------------------------- jobs

test("job status returns only the reduced job", async t => {
  const { port } = await setup(t);
  const reply = await call(port, { path: "/masumi/sokosumi/jobs/job-1" });
  assert.equal(reply.status, 200);
  assert.deepEqual(JSON.parse(reply.body), { id: "job-1", status: "completed", result: "IH", name: "Demo UI: hi" });
});

test("job status needs the frontend origin and the right Host", async t => {
  const { port, soko } = await setup(t);
  assert.equal((await call(port, { path: "/masumi/sokosumi/jobs/job-1", origin: null })).status, 403);
  assert.equal((await call(port, { path: "/masumi/sokosumi/jobs/job-1", origin: null, host: `evil.example:${port}` })).status, 403);
  assert.equal(soko.calls.length, 0);
});

test("an invalid job id gets 400", async t => {
  const { port, soko } = await setup(t);
  for (const id of ["a.b", "%2e%2e"]) assert.equal((await call(port, { path: `/masumi/sokosumi/jobs/${id}` })).status, 400, id);
  assert.equal(soko.calls.length, 0);
});

// ---------------------------------------------------------------- disabled and configuration

test("without a Sokosumi key the proxy does not exist and the config says so", async t => {
  const { port } = await setup(t, { sokosumi: false });
  assert.equal((await hire(port)).status, 404);
  assert.equal((await call(port, { path: "/masumi/sokosumi/jobs/job-1" })).status, 404);
  const config = JSON.parse((await call(port, { path: "/masumi/config" })).body);
  assert.equal(config.sokosumi.enabled, false, "the server's setting wins over the agent's");
});

test("with a key the config reports Sokosumi enabled", async t => {
  const { port } = await setup(t);
  assert.equal(JSON.parse((await call(port, { path: "/masumi/config" })).body).sokosumi.enabled, true);
});

test("frontend origins default to the dev server and reject anything but exact origins", () => {
  assert.deepEqual(parseFrontendOrigins(undefined), ["http://localhost:5173", "http://127.0.0.1:5173"]);
  assert.deepEqual(parseFrontendOrigins("  "), ["http://localhost:5173", "http://127.0.0.1:5173"]);
  assert.deepEqual(parseFrontendOrigins("http://127.0.0.1:44020"), ["http://127.0.0.1:44020"]);
  for (const bad of ["*", "null", "localhost:5173", "http://localhost:5173/", "ftp://x", "http://u@x"]) {
    assert.throws(() => parseFrontendOrigins(bad), Error, bad);
  }
});

test("the environment is checked at startup", () => {
  const base = { MASUMI_AGENT_URL: "http://127.0.0.1:8787" };
  assert.equal(masumiOptionsFromEnv(base).sokosumi, undefined);
  for (const cap of ["0", "-1", "abc"]) {
    assert.throws(() => masumiOptionsFromEnv({ ...base, SOKOSUMI_API_KEY: "k", SOKOSUMI_AGENT_ID: "a", SOKOSUMI_MAX_CREDITS: cap }), /SOKOSUMI_MAX_CREDITS/, cap);
  }
  // Without an id or exact name, a catalog lookup could hire someone else's agent.
  assert.throws(() => masumiOptionsFromEnv({ ...base, SOKOSUMI_API_KEY: "k" }), /SOKOSUMI_AGENT_ID|SOKOSUMI_AGENT_NAME/);
  assert.ok(masumiOptionsFromEnv({ ...base, SOKOSUMI_API_KEY: "k", SOKOSUMI_AGENT_NAME: "mine" }).sokosumi);
  assert.throws(() => masumiOptionsFromEnv({ MASUMI_AGENT_URL: "ftp://agent" }), /MASUMI_AGENT_URL/);
  assert.equal(masumiOptionsFromEnv({}).agentUrl, "http://127.0.0.1:8787");
  assert.throws(() => masumiOptionsFromEnv({ ...base, FRONTEND_ORIGINS: "*" }), /FRONTEND_ORIGINS/);
});

// ---------------------------------------------------------------- agent forward

test("the unpaid x402 request returns the agent's 402 offer, readable cross-origin", async t => {
  const { port } = await setup(t);
  const reply = await call(port, { method: "POST", path: "/masumi/x402/start_job", origin: "http://anywhere.example", body: JSON.stringify({ identifier_from_purchaser: "a1", input_data: { text: "hi" } }) });
  assert.equal(reply.status, 402);
  assert.equal(reply.headers["payment-required"], "required:/x402/start_job");
  assert.match(String(reply.headers["access-control-expose-headers"]), /PAYMENT-REQUIRED/);
});

test("the paid request relays the signature, body and receipt, and nothing else", async t => {
  const { port, agent } = await setup(t);
  const body = { identifier_from_purchaser: "a1", input_data: { text: "héllo   masumi" } };
  const reply = await call(port, { method: "POST", path: "/masumi/x402/start_job", body: JSON.stringify(body),
    headers: { "PAYMENT-SIGNATURE": "sig-bytes", cookie: "c=1", authorization: "Bearer x" } });
  assert.equal(reply.status, 200, reply.body);
  assert.equal(reply.headers["payment-response"], "receipt");
  assert.match(String(reply.headers["access-control-expose-headers"]), /PAYMENT-RESPONSE/);
  const seen = agent.seen.find(s => s.method === "POST")!;
  assert.equal(seen.headers["payment-signature"], "sig-bytes");
  assert.deepEqual(seen.body, body);
  for (const header of ["cookie", "authorization", "origin", "x-forwarded-for", "x-forwarded-host"]) assert.equal(seen.headers[header], undefined, header);
});

test("the tADA offer is forwarded to its own route", async t => {
  const { port, agent } = await setup(t);
  const reply = await call(port, { method: "POST", path: "/masumi/x402/start_job/ada", body: JSON.stringify({ identifier_from_purchaser: "a1", input_data: { text: "hi" } }) });
  assert.equal(reply.headers["payment-required"], "required:/x402/start_job/ada");
  assert.equal(agent.seen.at(-1)!.path, "/x402/start_job/ada");
});

test("the payment preflight allows the signature header", async t => {
  const { port } = await setup(t);
  const reply = await call(port, { method: "OPTIONS", path: "/masumi/x402/start_job", headers: { "access-control-request-method": "POST", "access-control-request-headers": "payment-signature, content-type" } });
  assert.equal(reply.status, 204);
  assert.match(String(reply.headers["access-control-allow-headers"]).toUpperCase(), /PAYMENT-SIGNATURE/);
});

test("a non-JSON x402 request gets 415 without reaching the agent", async t => {
  const { port, agent } = await setup(t);
  assert.equal((await call(port, { method: "POST", path: "/masumi/x402/start_job", headers: { "content-type": "text/plain" }, body: "{}" })).status, 415);
  assert.equal(agent.seen.length, 0);
});

test("job lookups by lock transaction are forwarded only for a 64-hex hash", async t => {
  const { port, agent } = await setup(t);
  const ok = await call(port, { path: `/masumi/jobs/by-tx/${HASH}` });
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).lockTx, HASH);
  assert.equal((await call(port, { path: "/masumi/jobs/by-tx/..%2Fdemo%2Fconfig" })).status, 400);
  assert.equal((await call(port, { path: `/masumi/jobs/by-tx/${"AB".repeat(32)}` })).status, 400);
  assert.equal(agent.seen.filter(s => s.path.startsWith("/jobs")).length, 1);
});

test("availability is forwarded", async t => {
  const { port } = await setup(t);
  const reply = await call(port, { path: "/masumi/availability" });
  assert.equal(reply.status, 200);
  assert.equal(JSON.parse(reply.body).status, "available");
});

test("an unreachable agent gives 502", async t => {
  const { port } = await setup(t, { agentUrl: "http://127.0.0.1:1" });
  assert.equal((await call(port, { path: "/masumi/availability" })).status, 502);
  assert.equal((await call(port, { method: "POST", path: "/masumi/x402/start_job", body: JSON.stringify({ identifier_from_purchaser: "a1", input_data: { text: "hi" } }) })).status, 502);
});

test("a paid request the agent never answers gives 504 after one attempt", async t => {
  const { port, agent } = await setup(t, { payMs: 300 });
  agent.state.hang = true;
  const reply = await call(port, { method: "POST", path: "/masumi/x402/start_job", headers: { "PAYMENT-SIGNATURE": "sig" }, body: JSON.stringify({ identifier_from_purchaser: "a1", input_data: { text: "hi" } }) });
  assert.equal(reply.status, 504);
  assert.match(reply.body, /jobs\/by-tx/);
  assert.equal(agent.seen.filter(s => s.method === "POST").length, 1);
});

test("an HTML error from the agent is relayed without crashing the server", async t => {
  const { port, agent } = await setup(t);
  agent.state.htmlError = true;
  const reply = await call(port, { method: "POST", path: "/masumi/x402/start_job", body: JSON.stringify({ identifier_from_purchaser: "a1", input_data: { text: "hi" } }) });
  assert.equal(reply.status, 500);
  assert.equal(reply.body, "<h1>oops</h1>");
  assert.equal((await call(port, { path: "/health" })).status, 200);
});

test("a non-JSON config from whatever answers at the agent URL gives 502, and the server keeps running", async t => {
  const { port, agent } = await setup(t);
  agent.state.htmlConfig = true;
  assert.equal((await call(port, { path: "/masumi/config", origin: "http://anywhere.example" })).status, 502);
  assert.equal((await call(port, { path: "/health" })).status, 200);
});

test("the Sokosumi guard refuses a client that is not on loopback", () => {
  const replies: number[] = [];
  let passed = false;
  const res = { status(code: number) { replies.push(code); return this; }, json() { return this; }, set() { return this; }, end() { return this; } };
  const req = { method: "POST", headers: { host: "127.0.0.1:4021", origin: ORIGIN }, socket: { localPort: 4021, remoteAddress: "192.168.1.20" }, is: () => "application/json" };
  sokosumiGuard(new Set([ORIGIN]))(req as never, res as never, () => { passed = true; });
  assert.deepEqual(replies, [403]);
  assert.equal(passed, false);
  sokosumiGuard(new Set([ORIGIN]))({ ...req, socket: { localPort: 4021, remoteAddress: "127.0.0.1" } } as never, res as never, () => { passed = true; });
  assert.equal(passed, true, "the same request from loopback passes");
});

test("a Masumi registry identifier in SOKOSUMI_AGENT_ID is refused with a pointer to the right id", () => {
  const registryId = `67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b10${"ab".repeat(28)}000000`;
  assert.throws(() => masumiOptionsFromEnv({ SOKOSUMI_API_KEY: "k", SOKOSUMI_AGENT_ID: registryId }), /Sokosumi's own agent id/);
  assert.ok(masumiOptionsFromEnv({ SOKOSUMI_API_KEY: "k", SOKOSUMI_AGENT_ID: "01a0f73f-26c5-704a-ae93-7673ee5f704c" }).sokosumi);
});
