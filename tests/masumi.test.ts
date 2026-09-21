import assert from "node:assert/strict";
import { test } from "node:test";
import { runPaymentFlow } from "../frontend/src/x402/flow.ts";
import { providerFixture } from "./provider-fixture.ts";

for (const method of ["masumi", "masumi-usdm"] as const) {
  test(`${method}: identical buyer and seller payout addresses are explained before wallet approval`, async t => {
    const fixture = await providerFixture(t, { buyerIsSeller: true });
    await assert.rejects(runPaymentFlow(fixture.origin, fixture.signer, () => {}, method), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /different buyer and seller.*addresses/i, JSON.stringify(fixture.state.verifications));
      return true;
    });
    assert.equal(fixture.state.signs, 0);
    assert.equal(fixture.state.submissions.length, 0);
    assert.equal(fixture.state.verifications.length, 0);
  });
}

test("normal verification failures log the SDK detail, not just transport exceptions", async t => {
  const fixture = await providerFixture(t);
  fixture.state.evaluationUnavailable = true;
  const lines: string[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => { lines.push(args.join(" ")); });
  await assert.rejects(runPaymentFlow(fixture.origin, fixture.signer, () => {}, "masumi"), /Payment rejected/);
  const result = fixture.state.verifications.find(result => !result.isValid)!;
  assert.ok(result.invalidMessage, "The official verifier should provide its provider error detail");
  assert.ok(lines.some(line => line.includes(result.invalidReason!) && line.includes(result.invalidMessage!)), "The seller log must preserve the available SDK reason and detail");
  assert.equal(fixture.state.submissions.length, 0);
});

for (const method of ["default", "usdm"] as const) {
  test(`${method}: ordinary same-wallet payments remain usable`, async t => {
    const fixture = await providerFixture(t, { buyerIsSeller: true });
    assert.equal((await runPaymentFlow(fixture.origin, fixture.signer, () => {}, method)).status, "settled");
    assert.equal(fixture.state.signs, 1);
    assert.equal(fixture.state.submissions.length, 1);
  });
}
