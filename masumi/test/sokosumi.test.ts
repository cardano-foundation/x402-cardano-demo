import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createSokosumi, sokosumiStage, type Fetch, type SokosumiStage } from "../src/sokosumi.js";

type Call = { url: string; method: string; headers: Record<string, string>; body?: unknown };

/** A fake Sokosumi: routes by "METHOD path" and records every call. */
function fake(routes: Record<string, (call: Call) => { status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const fetchImpl: Fetch = async (url, init) => {
    const call: Call = { url, method: init?.method ?? "GET", headers: init?.headers ?? {}, body: init?.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const path = new URL(url).pathname.replace(/^\/v1/, "") + new URL(url).search;
    const handler = Object.entries(routes).find(([key]) => key === `${call.method} ${path}` || key === `${call.method} ${path.split("?")[0]}`)?.[1];
    const { status = 200, body } = handler ? handler(call) : { status: 404, body: { error: "not found" } };
    return { ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return { calls, fetchImpl };
}
const envelope = (data: unknown, pagination?: unknown) => ({ data, meta: { timestamp: "t", requestId: "r", ...(pagination ? { pagination } : {}) } });
const client = (f: ReturnType<typeof fake>, agentId?: string) =>
  createSokosumi({ baseUrl: "https://soko.test/v1", apiKey: "key-123", agentName: "Thomas Test Agent", agentId, fetch: f.fetchImpl });

test("every call sends the API key as a Bearer token", async () => {
  const f = fake({ "GET /jobs/j1": () => ({ body: envelope({ id: "j1", status: "processing", result: null, name: "x" }) }) });
  await client(f).job("j1");
  assert.equal(f.calls[0].headers.Authorization, "Bearer key-123");
});

test("resolves the agent by a unique exact name across pages", async () => {
  const f = fake({
    "GET /agents?kind=cardano&limit=50": () => ({ body: envelope([{ id: "a1", name: "Other" }], { nextCursor: "a1" }) }),
    "GET /agents?kind=cardano&limit=50&cursor=a1": () => ({ body: envelope([{ id: "a2", name: "Thomas Test Agent" }], { nextCursor: null }) }),
  });
  assert.equal(await client(f).agentId(), "a2");
});

test("SOKOSUMI_AGENT_ID wins over the name lookup", async () => {
  const f = fake({});
  assert.equal(await client(f, "fixed-id").agentId(), "fixed-id");
  assert.equal(f.calls.length, 0);
});

test("refuses zero or several name matches", async () => {
  const none = fake({ "GET /agents?kind=cardano&limit=50": () => ({ body: envelope([{ id: "a1", name: "Other" }], { nextCursor: null }) }) });
  await assert.rejects(client(none).agentId(), /not listed|hidden/i);
  const two = fake({ "GET /agents?kind=cardano&limit=50": () => ({ body: envelope([{ id: "a1", name: "Thomas Test Agent" }, { id: "a2", name: "Thomas Test Agent" }], { nextCursor: null }) }) });
  await assert.rejects(client(two).agentId(), /SOKOSUMI_AGENT_ID/);
});

test("hire posts the input schema and text, capped by maxCredits", async () => {
  const schema = { input_data: [{ id: "text", type: "string", name: "Text" }] };
  const f = fake({
    "GET /agents/a2/input-schema": () => ({ body: envelope(schema) }),
    "POST /agents/a2/jobs": () => ({ status: 201, body: envelope({ id: "job-9", status: "payment_pending", result: null, name: "Job" }) }),
  });
  const job = await client(f, "a2").hire("hello masumi", 10);
  assert.deepEqual(job, { id: "job-9", status: "payment_pending", result: null, name: "Job" });
  assert.equal(f.calls.filter(c => c.method === "POST").length, 1, "never retried: one POST per hire");
  const post = f.calls.find(c => c.method === "POST")!;
  assert.deepEqual(post.body, { name: "Demo UI: hello masumi", inputSchema: schema, inputData: { text: "hello masumi" }, maxCredits: 10 });
});

test("a 404 on the agent explains that Sokosumi does not show it", async () => {
  const f = fake({});
  await assert.rejects(client(f, "a2").hire("hi"), /not.*(listed|shown|visible)|hidden/i);
});

test("job() returns only id, status, result and name", async () => {
  const f = fake({ "GET /jobs/j1": () => ({ body: envelope({ id: "j1", status: "completed", result: "IH", name: "Job", secret: "x", credits: 3 }) }) });
  assert.deepEqual(await client(f).job("j1"), { id: "j1", status: "completed", result: "IH", name: "Job" });
});

test("paging follows meta.pagination.nextCursor and stops on null", async () => {
  const f = fake({
    "GET /agents?kind=cardano&limit=50": () => ({ body: envelope([{ id: "a1", name: "Other" }], { nextCursor: "a1" }) }),
    "GET /agents?kind=cardano&limit=50&cursor=a1": () => ({ body: envelope([{ id: "a2", name: "Thomas Test Agent" }], { nextCursor: null }) }),
  });
  await client(f).agentId();
  assert.deepEqual(f.calls.map(c => new URL(c.url).search), ["?kind=cardano&limit=50", "?kind=cardano&limit=50&cursor=a1"]);
});

test("every Sokosumi job status maps to a stage, and non-happy ones stop polling", () => {
  const expected: Record<string, SokosumiStage> = {
    payment_pending: "paying", started: "working", processing: "working", result_pending: "working", completed: "done",
    failed: "stopped", payment_failed: "stopped", input_required: "stopped",
    refund_pending: "stopped", refund_resolved: "stopped", dispute_pending: "stopped", dispute_resolved: "stopped",
  };
  assert.equal(Object.keys(expected).length, 12);
  for (const [status, stage] of Object.entries(expected)) assert.equal(sokosumiStage(status), stage, status);
  assert.equal(sokosumiStage("something_new"), "stopped");
});
