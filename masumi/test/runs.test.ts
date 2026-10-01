import { strict as assert } from "node:assert";
import { test } from "node:test";
import { EXAMPLE_OFFER, exampleDeps } from "../src/ui/example.js";
import { createRuns } from "../src/ui/runs.js";
import { runX402 } from "../src/ui/x402Flow.js";

test("starting a real run aborts the replay and drops every late write of it", async () => {
  const runs = createRuns();
  const writes: string[] = [];
  const replay = runs.start("example");
  const replaying = runX402(EXAMPLE_OFFER, "hi", { ...exampleDeps(20, replay.signal), emit: (id, patch) => replay.guard(() => writes.push(`replay ${id}:${patch.status}`)) })
    .finally(() => replay.guard(() => writes.push("replay: setBusy(undefined)")));
  const before = writes.length; // the replay's synchronous first write happened before the real run started
  const real = runs.start("real");
  assert.equal(replay.signal.aborted, true);
  assert.equal(real.signal.aborted, false);
  await assert.rejects(replaying, /aborted/);
  real.guard(() => writes.push("real: step"));
  assert.deepEqual(writes.slice(before), ["real: step"], "nothing from the replay after the real run started (not even its failure emit)");
  assert.equal(runs.current()?.kind, "real");
});

test("a finished run stays current until the next one starts", () => {
  const runs = createRuns();
  const a = runs.start("real");
  const hits: number[] = [];
  a.guard(() => hits.push(1));
  runs.start("example");
  a.guard(() => hits.push(2));
  assert.deepEqual(hits, [1]);
});

test("stop() retires the current run, so its late writes are dropped", () => {
  const runs = createRuns();
  const a = runs.start("real");
  runs.stop();
  const hits: number[] = [];
  a.guard(() => hits.push(1));
  assert.equal(a.signal.aborted, true);
  assert.deepEqual(hits, []);
});
