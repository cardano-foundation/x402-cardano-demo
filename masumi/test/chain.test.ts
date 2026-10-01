import { strict as assert } from "node:assert";
import { test } from "node:test";
import { unspentEscrowOutputs, txOutputs } from "../src/chain.js";
import { ESCROW_ADDRESS } from "../src/constants.js";

const row = (output_index: number, address: string, consumed_by_tx: string | null = null, collateral = false) =>
  ({ output_index, address, consumed_by_tx, collateral });

test("locksOfTx keeps only unspent, non-collateral escrow outputs", () => {
  const rows = [
    row(0, ESCROW_ADDRESS),                         // the lock
    row(1, "addr_test1qqbuyerchange"),              // change
    row(2, ESCROW_ADDRESS, "ab".repeat(32)),        // already spent (e.g. refunded)
    row(3, ESCROW_ADDRESS, null, true),             // collateral return output
  ];
  assert.deepEqual(unspentEscrowOutputs(rows), [0]);
});

const blockfrost = { baseUrl: "https://bf", projectId: "p" };

test("an unknown transaction (404) yields no outputs instead of throwing", async () => {
  const outputs = await txOutputs(blockfrost, "ee".repeat(32), async () => ({ ok: false, status: 404, json: async () => ({}) }));
  assert.deepEqual(outputs, []);
});

test("other Blockfrost errors still throw", async () => {
  await assert.rejects(txOutputs(blockfrost, "ee".repeat(32), async () => ({ ok: false, status: 500, json: async () => ({}) })), /500/);
});

test("a known transaction returns its outputs", async () => {
  const outputs = await txOutputs(blockfrost, "ee".repeat(32), async url => {
    assert.equal(url, `https://bf/txs/${"ee".repeat(32)}/utxos`);
    return { ok: true, status: 200, json: async () => ({ outputs: [row(0, ESCROW_ADDRESS)] }) };
  });
  assert.deepEqual(unspentEscrowOutputs(outputs), [0]);
});
