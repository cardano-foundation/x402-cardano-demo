/**
 * docs/FLOWS.md explains the protocol with concrete names and numbers. These
 * tests read those facts from the code and fail when the document drifts.
 * chain.ts and agent.ts cannot be imported without side effects (they read the
 * environment and start servers), so their facts are read from source text.
 * The UI facts (datum field rows, step ids) are checked from the main demo, in
 * ../tests/masumi-tab-docs.test.ts, since the UI now lives there.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { STANDARD_DEADLINES } from "../src/masumi.js";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const flows = read("docs/FLOWS.md");
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("FLOWS.md names every redeemer with the index chain.ts builds", () => {
  const names: Record<string, string> = { submitResult: "SubmitResult", withdraw: "Withdraw", mint: "MintAction", burn: "BurnAction" };
  const found = [...read("src/chain.ts").matchAll(/^\s+(\w+): Data\.constr\((\d+)n, \[\]\)/gm)];
  assert.deepEqual(found.map(m => m[1]).sort(), Object.keys(names).sort(), "the REDEEMER table in chain.ts changed shape");
  for (const [, key, index] of found) {
    assert.match(flows, new RegExp(`\`${names[key]}\` \\| \`Constr ${index} \\[\\]\``), `${names[key]} should be Constr ${index}`);
  }
});

test("FLOWS.md shows every HTTP route the agent serves", () => {
  const agent = read("src/agent.ts");
  const routes = [...agent.matchAll(/\bapp\.(get|post)\("([^"]+)"/g)].map(m => `${m[1].toUpperCase()} ${m[2]}`);
  const paid = [...agent.matchAll(/x402Offer\("([^"]+)"/g)].map(m => `POST ${m[1]}`);
  // The exact surface: a route added or removed in agent.ts must be documented deliberately.
  assert.deepEqual([...routes, ...paid].sort(), [
    "GET /availability", "GET /demo/config", "GET /input_schema", "GET /jobs/:id", "GET /jobs/by-tx/:hash", "GET /status",
    "POST /start_job", "POST /x402/start_job", "POST /x402/start_job/ada",
  ]);
  // The route must end there: "POST /x402/start" must not pass by prefix.
  for (const route of [...routes, ...paid]) assert.match(flows, new RegExp(`${escape(route)}(?=[\`?\\s])`), `${route} is missing`);
});

test("FLOWS.md states the standard-path deadlines as STANDARD_DEADLINES defines them", () => {
  for (const [key, ms] of Object.entries(STANDARD_DEADLINES)) {
    assert.match(flows, new RegExp(`\\| \`${key}\` \\| \\+${ms / 60_000} min \\|`), `${key} should be +${ms / 60_000} min`);
  }
});

test("FLOWS.md uses the x402 header names", () => {
  for (const header of ["PAYMENT-REQUIRED", "PAYMENT-SIGNATURE", "PAYMENT-RESPONSE"]) assert.ok(flows.includes(header), header);
});
