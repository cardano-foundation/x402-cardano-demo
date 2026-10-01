/**
 * docs/FLOWS.md explains the protocol with concrete names and numbers. These
 * tests read those facts from the code and fail when the document drifts.
 * chain.ts and agent.ts cannot be imported without side effects (they read the
 * environment and start servers), so their facts are read from source text.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildMasumiLockDatum, parseMasumiLockDatum, toMasumiSellerSigner } from "@x402/cardano";
import { STANDARD_DEADLINES } from "../src/masumi.js";
import { sokosumiSteps } from "../src/ui/sokosumiFlow.js";
import { datumRows } from "../src/ui/steps.js";
import { EXAMPLE_OFFER } from "../src/ui/example.js";
import { x402Steps } from "../src/ui/x402Flow.js";

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

test("FLOWS.md shows every HTTP route the agent and the proxy serve", () => {
  const agent = read("src/agent.ts");
  const routes = [...agent.matchAll(/\b(?:app|proxy)\.(get|post)\("([^"]+)"/g)].map(m => `${m[1].toUpperCase()} ${m[2]}`);
  const paid = [...agent.matchAll(/x402Offer\("([^"]+)"/g)].map(m => `POST ${m[1]}`);
  assert.ok(routes.length >= 8 && paid.length === 2, "route extraction found too little");
  // The route must end there: "POST /x402/start" must not pass by prefix.
  for (const route of [...routes, ...paid]) assert.match(flows, new RegExp(`${escape(route)}(?=[\`?\\s])`), `${route} is missing`);
});

test("FLOWS.md states the standard-path deadlines as STANDARD_DEADLINES defines them", () => {
  for (const [key, ms] of Object.entries(STANDARD_DEADLINES)) {
    assert.match(flows, new RegExp(`\\| \`${key}\` \\| \\+${ms / 60_000} min \\|`), `${key} should be +${ms / 60_000} min`);
  }
});

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

test("FLOWS.md uses the x402 header names", () => {
  for (const header of ["PAYMENT-REQUIRED", "PAYMENT-SIGNATURE", "PAYMENT-RESPONSE"]) assert.ok(flows.includes(header), header);
});

test("FLOWS.md explains every UI step of both flows by id", () => {
  for (const step of [...x402Steps(EXAMPLE_OFFER), ...sokosumiSteps()]) {
    assert.match(flows, new RegExp(`\`${escape(step.id)}\``), `step ${step.id} is not explained`);
  }
});
