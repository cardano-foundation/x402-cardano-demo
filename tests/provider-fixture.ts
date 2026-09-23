import assert from "node:assert/strict";
import cors from "cors";
import express from "express";
import { Address, Assets, CBOR, Client, preprod, TransactionHash, TransactionWitnessSet, UTxO } from "@evolution-sdk/evolution";
import { decodeCardanoTransaction, parseAssetUnit, toFacilitatorCardanoSigner, USDM_PREPROD_ASSET } from "@x402/cardano";
import { ExactCardanoScheme } from "@x402/cardano/exact/facilitator";
import { x402Facilitator } from "@x402/core/facilitator";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { VerifyResponse } from "@x402/core/types";
import { createCip30Signer } from "../frontend/src/x402/cip30Signer.ts";
import { createResourceApp } from "../server/src/app.ts";
import { confirmExpiry } from "../facilitator/src/settlement.ts";
import { seller } from "./fixtures.ts";

const protocol = {
  min_fee_a: 44, min_fee_b: 155381, pool_deposit: "500000000", key_deposit: "2000000",
  max_tx_size: 16384, max_val_size: "5000", max_block_size: 90112,
  coins_per_utxo_size: "4310", collateral_percent: 150, max_collateral_inputs: 3,
};

interface FixtureCleanup { after(cleanup: () => void | Promise<void>): void }

async function listen(app: express.Express, t: FixtureCleanup) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

/** Real CIP-30 signing and published provider adapters; only the chain is local.
 * Responses include the fields consumed by Evolution's actual Blockfrost schemas.
 * The public test phrase and funding input are fictional, never live funds. */
export async function providerFixture(t: FixtureCleanup, options: { buyerIsSeller?: boolean } = {}) {
  const wallet = Client.make(preprod).withSeed({ mnemonic: options.buyerIsSeller
    ? "test test test test test test test test test test test junk"
    : "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" });
  const address = await wallet.address();
  const payer = Address.toBech32(address);
  const fundingHash = "b".repeat(64);
  const { policyId, assetNameHex } = parseAssetUnit(USDM_PREPROD_ASSET);
  const assets = Assets.addByHex(Assets.fromLovelace(100_000_000n), policyId, assetNameHex, 10_000_000n);
  const funding = new UTxO.UTxO({ address, transactionId: TransactionHash.fromHex(fundingHash), index: 0n, assets, datumOption: undefined, scriptRef: undefined });
  const cbor = CBOR.toCBORHex([
    [Buffer.from(fundingHash, "hex"), 0n],
    [Buffer.from(Address.toHex(address), "hex"), [assets.lovelace,
      new Map([[Buffer.from(policyId, "hex"), new Map([[Buffer.from(assetNameHex, "hex"), 10_000_000n]])]])]],
  ]);
  const state = { signs: 0, walletSubmits: 0, confirmations: 1, spent: false,
    submissions: [] as Buffer[], verifications: [] as VerifyResponse[], txHash: "", requests: [] as string[], rejected: false, evaluationUnavailable: false, evidenceUnavailable: false };
  const amount = [{ unit: "lovelace", quantity: String(assets.lovelace) }, { unit: policyId + assetNameHex, quantity: "10000000" }];
  const output = () => ({ address: payer, output_index: 0, amount, data_hash: null, inline_datum: null,
    reference_script_hash: null, collateral: false, consumed_by_tx: state.spent ? state.txHash : null });
  const blockfrost = express();
  blockfrost.use(cors({ origin: true, allowedHeaders: ["Content-Type", "project_id"] }));
  blockfrost.use((req, _res, next) => { state.requests.push(`${req.method} ${req.path}`); assert.equal(req.get("project_id"), "offline-fixture"); next(); });
  blockfrost.get("/epochs/latest/parameters", (_req, res) => { res.json(protocol); });
  blockfrost.get(`/addresses/${payer}/utxos`, (_req, res) => {
    res.json(state.spent ? [] : [{ ...output(), tx_hash: fundingHash, tx_index: 0, block: "c".repeat(64) }]);
  });
  blockfrost.get(`/txs/${fundingHash}/utxos`, (_req, res) => { res.json({ hash: fundingHash, inputs: [], outputs: [output()] }); });
  blockfrost.get("/txs/:hash", (req, res) => {
    if (state.evidenceUnavailable) { res.status(503).json({ status_code: 503, error: "Service Unavailable", message: "Indexer unavailable" }); return; }
    if (req.params.hash !== state.txHash || state.confirmations < 0) { res.status(404).json({ status_code: 404, error: "Not Found", message: "Transaction not found" }); return; }
    res.json({ hash: state.txHash, block_height: 100, valid_contract: true });
  });
  blockfrost.get("/blocks/latest", (_req, res) => { res.json({ height: 100 + state.confirmations }); });
  blockfrost.post("/utils/txs/evaluate/utxos", express.json(), (_req, res) => {
    if (state.evaluationUnavailable) { res.status(503).json({ status_code: 503, error: "Service Unavailable", message: "Evaluator unavailable" }); return; }
    res.json({ result: { EvaluationResult: {} } });
  });
  blockfrost.post("/tx/submit", express.raw({ type: "*/*", limit: "1mb" }), (req, res) => {
    assert.equal(req.get("content-type"), "application/cbor");
    const bytes = Buffer.from(req.body);
    state.submissions.push(bytes);
    if (state.rejected) { res.status(400).json({ status_code: 400, error: "Bad Request", message: "BadInputsUTxO" }); return; }
    state.txHash = decodeCardanoTransaction(bytes.toString("base64")).txHash;
    state.spent = true;
    res.json(state.txHash);
  });
  blockfrost.use((req, res) => { res.status(501).json({ error: `Unhandled fixture endpoint ${req.method} ${req.path}` }); });
  const blockfrostUrl = await listen(blockfrost, t);
  const api = {
    getNetworkId: async () => 0,
    getUsedAddresses: async () => [Address.toHex(address)], getUnusedAddresses: async () => [],
    getUtxos: async () => [cbor],
    signTx: async (tx: string) => { state.signs++; return TransactionWitnessSet.toCBORHex(await wallet.signTx(tx, { utxos: [funding] })); },
    submitTx: async () => { state.walletSubmits++; assert.fail("The CIP-30 browser must never submit a payment"); },
  };
  const provider = { baseUrl: blockfrostUrl, projectId: "offline-fixture" };
  const signer = await createCip30Signer(api, provider);
  const chain = toFacilitatorCardanoSigner({ network: "cardano:preprod", provider: { blockfrost: provider }, awaitConfirmation: false });
  const facilitator = new x402Facilitator().register("cardano:preprod", new ExactCardanoScheme(chain, { confirmationTimeoutMs: 10, confirmationPollMs: 1 }));
  const facilitatorApp = express();
  facilitatorApp.use(express.json({ limit: "1mb" }));
  facilitatorApp.get("/supported", (_req, res) => { res.json(facilitator.getSupported()); });
  for (const action of ["verify", "settle"] as const) {
    facilitatorApp.post(`/${action}`, async (req, res) => {
      const result = action === "settle"
        ? await confirmExpiry(await facilitator.settle(req.body.paymentPayload, req.body.paymentRequirements), chain)
        : await facilitator.verify(req.body.paymentPayload, req.body.paymentRequirements);
      if (action === "verify") state.verifications.push(result as VerifyResponse);
      res.json(result);
    });
  }
  const facilitatorUrl = await listen(facilitatorApp, t);
  const app = await createResourceApp({ facilitator: new HTTPFacilitatorClient({ url: facilitatorUrl }), payTo: seller.sellerAddress, masumiSeller: seller });
  return { state, signer, api, provider, payer, origin: await listen(app, t) };
}
