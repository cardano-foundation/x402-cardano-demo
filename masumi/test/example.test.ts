/** The replay is the real x402 flow module against a simulated agent and wallet, so its data cannot drift. */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { EXAMPLE_OFFER, exampleDeps } from "../src/ui/example.js";
import { updateStep, type Step } from "../src/ui/steps.js";
import { runX402, x402Steps } from "../src/ui/x402Flow.js";

test("the example runs through the real runX402 to completion, with data on every step", async () => {
  let steps: Step[] = x402Steps(EXAMPLE_OFFER);
  const job = await runX402(EXAMPLE_OFFER, "hello masumi", { ...exampleDeps(0), emit: (id, patch) => { steps = updateStep(steps, id, patch); } });
  assert.equal(job.status, "completed");
  assert.equal(job.result, "IMUSAM OLLEH");
  for (const step of steps) {
    assert.equal(step.status, "done", step.id);
    assert.ok(step.data !== undefined, `${step.id} has data`);
  }
  const signed = steps.find(s => s.id === "sign")!.data as { datum: { state: bigint; sellerNonce: string } };
  assert.equal(signed.datum.state, 0n, "library-parsed datum (bigint state)");
  const settle = steps.find(s => s.id === "settle")!.data as { receipt?: { transaction: string }; paymentSignature?: unknown };
  assert.ok(settle.receipt && settle.paymentSignature, "receipt and payload");
  const verify = steps.find(s => s.id === "verify")!.data as { registry: string };
  assert.equal(verify.registry, "checked");
});

test("an aborted example stops instead of running to completion", async () => {
  const controller = new AbortController();
  const run = runX402(EXAMPLE_OFFER, "hi", { ...exampleDeps(50, controller.signal), emit: () => {} });
  controller.abort();
  await assert.rejects(run, /aborted/);
});
