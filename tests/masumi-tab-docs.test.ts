/**
 * masumi/docs/FLOWS.md explains each flow with the names the Masumi tab and
 * the server use. Moved here from masumi/test/docs.test.ts with the UI; these
 * fail when the document drifts from the code.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildMasumiLockDatum, parseMasumiLockDatum, toMasumiSellerSigner } from "@x402/cardano";
import { sokosumiSteps } from "../frontend/src/masumi/sokosumiFlow.ts";
import { datumRows } from "../frontend/src/masumi/steps.ts";
import { EXAMPLE_OFFER } from "../frontend/src/masumi/example.ts";
import { x402Steps } from "../frontend/src/masumi/x402Flow.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const flows = read("masumi/docs/FLOWS.md");
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("FLOWS.md lists the 19 datum fields in on-chain order", () => {
  const mnemonic = "test test test test test test test test test test test junk";
  const seller = toMasumiSellerSigner({ network: "cardano:preprod", mnemonic });
  const view = parseMasumiLockDatum(buildMasumiLockDatum({
    buyerAddress: seller.sellerAddress, sellerAddress: seller.sellerAddress, referenceKey: "a4".repeat(20), referenceSignature: "84".repeat(40),
    sellerNonce: "11".repeat(32), buyerNonce: "", agentIdentifier: "", collateralReturnLovelace: 0n, inputHash: "33".repeat(32),
    payByTime: 1n, submitResultTime: 2n, unlockTime: 3n, externalDisputeUnlockTime: 4n,
  }))!;
  const documented = [...flows.matchAll(/^\| (\d+) \| `(\w+)` \|/gm)].map(m => [Number(m[1]), m[2]]);
  assert.deepEqual(documented, datumRows(view).map(r => [r.index, r.field]));
});

test("FLOWS.md explains every UI step of both flows by id", () => {
  for (const step of [...x402Steps(EXAMPLE_OFFER), ...sokosumiSteps()]) {
    assert.match(flows, new RegExp(`\`${escape(step.id)}\``), `step ${step.id} is not explained`);
  }
});

test("FLOWS.md shows every /masumi route the server serves", () => {
  const server = read("server/src/masumi.ts");
  const routes = [...server.matchAll(/router\.(get|post)\("([^"]+)"/g)].map(m => [m[1].toUpperCase(), m[2]]);
  const paid = [...server.matchAll(/for \(const path of \[([^\]]+)\]\)/g)].flatMap(m => [...m[1].matchAll(/"([^"]+)"/g)].map(p => ["POST", p[1]]));
  // Sokosumi routes are mounted at /masumi/sokosumi, the agent forward at /masumi.
  const sokosumi = new Set(["/hire", "/jobs/:id"]);
  const documented = [...routes, ...paid].map(([method, path]) => `${method} /masumi${sokosumi.has(path) ? "/sokosumi" : ""}${path}`);
  assert.deepEqual([...documented].sort(), [
    "GET /masumi/availability", "GET /masumi/config", "GET /masumi/jobs/by-tx/:hash", "GET /masumi/sokosumi/jobs/:id",
    "POST /masumi/sokosumi/hire", "POST /masumi/x402/start_job", "POST /masumi/x402/start_job/ada",
  ]);
  for (const route of documented) assert.match(flows, new RegExp(`${escape(route)}(?=[\`?\\s])`), `${route} is missing`);
});
