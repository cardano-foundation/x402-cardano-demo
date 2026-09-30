/**
 * Checks against a running agent and the chain, without spending anything.
 *
 *   npm run check-quote      the x402 402 passes the buyer's checks (@x402/cardano)
 *   npm run check-purchase   the MIP-003 start_job response passes Sokosumi's and
 *                            the Payment Service's purchase checks
 *   npm run check-registry   the registry NFT, its metadata and holder are what
 *                            both hire paths require
 */
import { randomBytes } from "node:crypto";
import { validateMasumiExtra, verifyMasumiAuthorization } from "@x402/cardano";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { sokosumiPurchaseBody, verifyPurchase } from "../../test/vendor/paymentServiceVerifier.js";
import { agentIdentifier, blockfrost, listing, port, priceUnits, publicUrl, sellerWallet } from "../config.js";
import { ESCROW_ADDRESS, NETWORK, TUSDM_UNIT, TUSDM_X402_ASSET, unitKey } from "../constants.js";
import { registryMetadata } from "../masumi.js";
import { makeRegistryValidator } from "../registry.js";

const agent = `http://localhost:${port}`;
const body = () => ({ identifier_from_purchaser: randomBytes(10).toString("hex"), input_data: { text: "check" } });
const post = (path: string, json: unknown) => fetch(`${agent}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(json) });
async function blockfrostGet(path: string) {
  const response = await fetch(`${blockfrost.baseUrl}${path}`, { headers: { project_id: blockfrost.projectId } });
  return response.ok ? response.json() : undefined;
}
function ok(label: string) { console.log(`ok  ${label}`); }
function fail(label: string): never { console.error(`FAIL ${label}`); process.exit(1); }

async function checkQuote() {
  const { offers } = await (await fetch(`${agent}/demo/config`)).json() as { offers: Array<{ path: string; amount: string; asset: string; registered: boolean }> };
  for (const expected of offers) {
    const request = body();
    const response = await post(expected.path, request);
    if (response.status !== 402) fail(`${expected.path}: expected HTTP 402, got ${response.status}`);
    const required = decodePaymentRequiredHeader(response.headers.get("PAYMENT-REQUIRED") ?? fail("no PAYMENT-REQUIRED header"));
    for (const offer of required.accepts) {
      const schema = validateMasumiExtra(offer.extra, offer.network);
      if (!schema.ok) fail(`masumi extra: ${schema.detail}`);
      if (unitKey(offer.asset) !== unitKey(expected.asset) || offer.amount !== expected.amount) fail(`${expected.path}: price differs from /demo/config`);
      const claim = schema.extra.terms.agentIdentifier ?? "";
      if (expected.registered ? claim !== agentIdentifier() : claim !== "") fail(`${expected.path}: unexpected agentIdentifier "${claim}"`);
      if (expected.registered && (unitKey(offer.asset) !== TUSDM_UNIT || offer.amount !== priceUnits.toString())) fail("the registered offer is not the registered tUSDM price");
      // Stubbed registry for the claimed offer: this check is about the quote; check-registry covers the chain.
      const stub = async (c: { agentIdentifier: string; amount: string; asset: string }) =>
        c.agentIdentifier === agentIdentifier() && c.amount === priceUnits.toString() && c.asset === TUSDM_X402_ASSET;
      const authorization = await verifyMasumiAuthorization(schema.extra, offer, {
        requireAllPartContent: true, resource: required.resource, ...(expected.registered ? { validateRegistryClaim: stub } : {}),
      });
      if (!authorization.ok) fail(`${expected.path}: buyer-side authorization: ${authorization.reason}`);
      if (JSON.stringify(schema.extra.inputCommitment.parts[0].content) !== JSON.stringify(request)) fail("the quote commits to a different job");
    }
    ok(`x402 ${expected.registered ? "registered" : "unlisted"} offer ${expected.path} (${expected.amount} ${expected.asset === "lovelace" ? "lovelace" : "tUSDM units"}) passes the buyer's checks`);
  }
}

async function checkPurchase() {
  const request = body();
  const response = await post("/start_job", request);
  if (!response.ok) fail(`start_job returned HTTP ${response.status}`);
  const id = agentIdentifier();
  const holders = await blockfrostGet(`/assets/${id}/addresses`) as Array<{ address: string }> | undefined;
  const asset = await blockfrostGet(`/assets/${id}`) as { onchain_metadata?: unknown } | undefined;
  const live = Boolean(holders?.length && asset?.onchain_metadata);
  if (!live) console.warn("warn registry NFT not found on chain; checking against the local listing instead");
  const purchase = sokosumiPurchaseBody(await response.json(), {
    agentIdentifier: id, identifierFromPurchaser: request.identifier_from_purchaser, amounts: [{ amount: priceUnits.toString(), unit: TUSDM_UNIT }],
  });
  await verifyPurchase(purchase, {
    nftHolderAddress: live ? holders![0].address : sellerWallet().address,
    onchainMetadata: live ? asset!.onchain_metadata : JSON.parse(JSON.stringify(registryMetadata(listing()))),
    smartContractAddress: ESCROW_ADDRESS, network: "Preprod",
  }).catch(error => fail(`Payment Service would reject the purchase: ${error.message}`));
  ok(`start_job response passes Sokosumi and Payment Service checks${live ? " against live registry data" : ""}`);
}

async function checkRegistry() {
  const id = agentIdentifier();
  const seller = sellerWallet().address;
  const holders = await blockfrostGet(`/assets/${id}/addresses`) as Array<{ address: string }> | undefined;
  if (!holders?.length) fail(`${id} is not on chain yet (or the Blockfrost key is wrong)`);
  if (holders[0].address !== seller) fail(`the NFT sits at ${holders[0].address}, not at the seller address ${seller}; Sokosumi purchases would fail`);
  ok("the registry NFT is held by the exact seller address");
  const valid = await makeRegistryValidator(blockfrost)({
    agentIdentifier: id, sellerAddress: seller, network: NETWORK, amount: priceUnits.toString(), asset: TUSDM_X402_ASSET,
    resource: { url: `${publicUrl()}/x402/start_job` },
  });
  if (!valid) fail("the registry metadata does not match the price, escrow or AGENT_PUBLIC_URL");
  ok("the registry metadata matches the price, the escrow and AGENT_PUBLIC_URL");
  const availability = await fetch(`${publicUrl()}/availability`).then(r => r.json()).catch(() => undefined) as { agentIdentifier?: string } | undefined;
  if (availability?.agentIdentifier !== id) console.warn(`warn ${publicUrl()}/availability is not reachable or reports another agent; the registry will show it offline`);
  else ok("the public /availability endpoint answers for this agent");
}

const checks = { quote: checkQuote, purchase: checkPurchase, registry: checkRegistry } as const;
const which = process.argv[2] as keyof typeof checks;
if (!checks[which]) fail(`usage: check.ts ${Object.keys(checks).join("|")}`);
await checks[which]();
