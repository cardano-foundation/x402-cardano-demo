/** The UI's Sokosumi flow with a fake local proxy: it ends like the x402 flow, with collect checked. */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { runSokosumi, sokosumiSteps, type SokosumiStepId } from "../src/ui/sokosumiFlow.js";
import { updateStep, type Step } from "../src/ui/steps.js";

function run(statuses: string[]) {
  let steps: Step[] = sokosumiSteps();
  let poll = 0;
  const api = async (path: string) => {
    if (path === "/sokosumi/hire") return new Response(JSON.stringify({ id: "job-1", status: "payment_pending", result: null, name: "x" }), { status: 201 });
    const status = statuses[Math.min(poll++, statuses.length - 1)];
    return new Response(JSON.stringify({ id: "job-1", status, result: status === "completed" ? "IH" : null, name: "x" }));
  };
  const done = runSokosumi("hi", { api, emit: (id: SokosumiStepId, patch) => { steps = updateStep(steps, id, patch); }, sleep: async () => {} });
  return { done, steps: () => steps };
}

test("a completed Sokosumi job checks every step, ending with the agent-driven collect step", async () => {
  const r = run(["processing", "completed"]);
  assert.equal((await r.done).result, "IH");
  const collect = r.steps().find(s => s.id === "collect");
  assert.ok(collect, "the Sokosumi path has a collect step");
  assert.equal(collect.actor, "agent");
  assert.equal(r.steps().at(-1)!.id, "collect", "collect is the last step");
  for (const step of r.steps()) assert.equal(step.status, "done", step.id);
});

test("a failed Sokosumi job fails the step that was running", async () => {
  const r = run(["processing", "failed"]);
  await assert.rejects(r.done, /stopped the job: failed/);
  assert.equal(r.steps().find(s => s.id === "work")!.status, "failed");
  assert.equal(r.steps().find(s => s.id === "collect")!.status, "pending");
});
