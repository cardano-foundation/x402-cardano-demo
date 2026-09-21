import assert from "node:assert/strict";
import { test } from "node:test";
import { Address, Assets, TransactionHash, UTxO } from "@evolution-sdk/evolution";
import { createCip30Signer, liveUtxos } from "../frontend/src/x402/cip30Signer.ts";
import { createFixture, seller } from "./fixtures.ts";
const provider = { baseUrl: "https://cardano-preprod.blockfrost.io/api/v0", projectId: "fixture" };

test("wallet UTxOs are checked at every owning address, not only the change address", async t => {
  const fixture = await createFixture();
  const addresses = [fixture.payer, seller.sellerAddress];
  const utxos = addresses.map((address, index) => new UTxO.UTxO({ address: Address.fromBech32(address), transactionId: TransactionHash.fromHex(String(index + 1).repeat(64)), index: 0n, assets: Assets.fromLovelace(10_000_000n), datumOption: undefined, scriptRef: undefined }));
  const seen: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    seen.push(url);
    const index = addresses.findIndex(address => url.includes(address));
    assert.notEqual(index, -1);
    return Response.json([{ tx_hash: String(index + 1).repeat(64), output_index: 0 }]);
  });
  assert.deepEqual(await liveUtxos(utxos, provider), utxos);
  assert.equal(seen.length, 2);
});

test("unavailable preprod evidence fails closed before asking the wallet to sign", async t => {
  const utxo = new UTxO.UTxO({ address: Address.fromBech32(seller.sellerAddress), transactionId: TransactionHash.fromHex("a".repeat(64)), index: 0n, assets: Assets.fromLovelace(10_000_000n), datumOption: undefined, scriptRef: undefined });
  t.mock.method(globalThis, "fetch", async () => new Response("unavailable", { status: 503 }));
  await assert.rejects(liveUtxos([utxo], provider), /Blockfrost.*503/);
});

test("mainnet wallets are rejected before constructing a transaction", async () => {
  await assert.rejects(createCip30Signer({ getNetworkId: async () => 1 }, provider), /preprod/);
});

test("CIP-30 builds the requested payment, spends its nonce, signs once and never broadcasts", async t => {
  const { CBOR, Client, preprod, TransactionWitnessSet } = await import("@evolution-sdk/evolution");
  const { decodeCardanoTransaction } = await import("@x402/cardano");
  const wallet = Client.make(preprod).withSeed({ mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" });
  const address = await wallet.address();
  const utxo = new UTxO.UTxO({ address, transactionId: TransactionHash.fromHex("b".repeat(64)), index: 0n, assets: Assets.fromLovelace(100_000_000n), datumOption: undefined, scriptRef: undefined });
  let signs = 0;
  const api = {
    getNetworkId: async () => 0,
    getUsedAddresses: async () => [Address.toHex(address)], getUnusedAddresses: async () => [],
    getUtxos: async () => [CBOR.toCBORHex([[Buffer.from("b".repeat(64), "hex"), 0n], [Buffer.from(Address.toHex(address), "hex"), 100_000_000n]])],
    signTx: async (tx: string) => { signs++; return TransactionWitnessSet.toCBORHex(await wallet.signTx(tx, { utxos: [utxo] })); },
    submitTx: async () => { assert.fail("The browser must never submit the transaction"); },
  };
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("/addresses/")) return Response.json([{ tx_hash: "b".repeat(64), output_index: 0 }]);
    assert.ok(url.endsWith("/epochs/latest/parameters"), url);
    return Response.json({ min_fee_a: 44, min_fee_b: 155381, pool_deposit: "500000000", key_deposit: "2000000", max_tx_size: 16384, max_val_size: "5000", max_block_size: 90112, coins_per_utxo_size: "4310", collateral_percent: 150, max_collateral_inputs: 3 });
  });
  const signer = await createCip30Signer(api, provider);
  const result = await signer.buildAndSignPaymentTransaction({ network: "cardano:preprod", payTo: seller.sellerAddress, asset: "lovelace", amount: "2000000", maxTimeoutSeconds: 600 });
  const transaction = decodeCardanoTransaction(result.transaction);
  assert.equal(result.nonce, `${"b".repeat(64)}#0`);
  assert.equal(transaction.outputs.find(output => output.address === seller.sellerAddress)?.coin, 2_000_000n);
  assert.equal(signs, 1);
  assert.ok(transaction.ttlSlot);
  assert.ok(transaction.inputs.includes(result.nonce));
});
