/**
 * The Masumi agent. Two ways to hire it, one escrow lifecycle:
 *
 *   POST /start_job        Standard Masumi (MIP-003). Sokosumi, Soko Bot or any
 *                          Payment Service buyer gets signed terms and locks the
 *                          funds itself.
 *   POST /x402/start_job   x402. The 402 carries Masumi escrow terms issued by
 *                          @x402/cardano; the paid retry carries the signed lock.
 *
 * A watcher finds each job's lock in the escrow, runs the task and submits the
 * result hash on chain. The seller collects later with `npm run collect`.
 *
 * Reading guide (top to bottom):
 *   1. the dummy task and input validation          (replace these for a real agent)
 *   2. the x402 side: in-process facilitator, one issuer + route per offer
 *   3. the watcher: lock matching, running the job, SubmitResult
 *   4. the HTTP routes (MIP-003 + x402 + demo extras)
 *   5. the operator-only Sokosumi proxy
 *
 * HTTP surface (public port):
 *   GET  /availability          MIP-003 health; the registry calls it to mark the agent Online
 *   GET  /input_schema          MIP-003 input form
 *   POST /start_job             MIP-003 purchase terms (standard path)
 *   POST /x402/start_job[/ada]  x402: 402 offer, then paid retry with PAYMENT-SIGNATURE
 *   GET  /status?job_id=        MIP-003 job status (Sokosumi polls this)
 *   GET  /jobs/:id, /jobs/by-tx/:hash, /demo/config   demo extras for the UI
 * See docs/FLOWS.md for every request and response in detail.
 */
import express, { type NextFunction, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { decodeCardanoTransaction, toFacilitatorCardanoSigner, type CardanoExtraMasumi } from "@x402/cardano";
import { ExactCardanoScheme as FacilitatorScheme } from "@x402/cardano/exact/facilitator";
import { ExactCardanoScheme as ServerScheme } from "@x402/cardano/exact/server";
import { x402Facilitator } from "@x402/core/facilitator";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { x402HTTPResourceServer, x402ResourceServer, type FacilitatorClient, type HTTPTransportContext } from "@x402/core/server";
import { paymentMiddlewareFromHTTPServer } from "@x402/express";
import { adaPriceLovelace, agentIdentifier as configuredAgentIdentifier, blockfrost, port, priceUnits, publicUrl, sellerWallet, sokosumi } from "./config.js";
import { createSokosumi } from "./sokosumi.js";
import { createChain } from "./chain.js";
import { ESCROW_ADDRESS, NETWORK, paymentKeyHash, TUSDM_UNIT, TUSDM_X402_ASSET } from "./constants.js";
import { findLock, lockMismatch, type EscrowUtxo, type ExpectedLock } from "./lockMatch.js";
import { resultHash, standardTerms } from "./masumi.js";
import { lockSnapshot, view, type Job, type JobInput } from "./jobView.js";
import { makeRegistryValidator } from "./registry.js";

// ---------------------------------------------------------------- the dummy task

/** MIP-003 input schema: a single text field. */
const INPUT_SCHEMA = {
  input_data: [{
    id: "text", type: "string", name: "Text",
    data: { placeholder: "hello masumi", description: "Text to transform (max 500 characters)" },
    validations: [{ validation: "max", value: "500" }],
  }],
};
/** The "work": reverse and upper-case the text. Replace this with your agent. */
const runTask = (input: { text: string }) => [...input.text].reverse().join("").toUpperCase();

/** Validates a MIP-003 job body; returns the parsed input or an error message. */
function parseJobInput(body: unknown): JobInput | string {
  const { identifier_from_purchaser: id, input_data: data } = (body ?? {}) as Record<string, unknown>;
  // Even-length hex: the buyer nonce is stored as bytes in the escrow datum.
  if (typeof id !== "string" || !/^([0-9a-f]{2}){7,32}$/.test(id)) return "identifier_from_purchaser must be 14-64 lowercase hex characters";
  const text = (data as { text?: unknown } | undefined)?.text;
  if (typeof text !== "string" || !text.trim() || text.length > 500) return "input_data.text must be 1-500 characters";
  return { identifier_from_purchaser: id, input_data: { text } };
}

// ---------------------------------------------------------------- jobs

const jobs = new Map<string, Job>();
const jobsByTx = new Map<string, Job>();

const seller = sellerWallet();
const agentIdentifier = configuredAgentIdentifier();
const chain = createChain({ blockfrost, mnemonic: seller.mnemonic, sellerAddress: seller.address });
const validateRegistryClaim = makeRegistryValidator(blockfrost);

// ---------------------------------------------------------------- x402
//
// x402 has three roles: the client (the UI's wallet), the resource server
// (this agent's route) and the facilitator (verifies the payment and puts it
// on chain). Here the facilitator runs inside the agent and holds no keys: it
// only verifies and broadcasts the buyer's already signed transaction.

const facilitator = new x402Facilitator().register(NETWORK, new FacilitatorScheme(
  toFacilitatorCardanoSigner({ network: NETWORK, provider: { blockfrost }, awaitConfirmation: false }),
  { validateRegistryClaim },
));
/** The in-process facilitator, shaped as the client the resource server expects. */
const facilitatorClient: FacilitatorClient = {
  verify: (payload, requirements) => facilitator.verify(payload, requirements),
  settle: (payload, requirements) => facilitator.settle(payload, requirements),
  getSupported: async () => facilitator.getSupported() as Awaited<ReturnType<FacilitatorClient["getSupported"]>>,
};
/**
 * One x402 offer: its own issuer (the registry claim is per issuer, not per
 * offer), resource server and route. Quotes of one offer are unknown to the other.
 */
function x402Offer(path: string, price: { amount: string; asset: string }, claim: string | undefined) {
  const server = new x402ResourceServer(facilitatorClient).register(NETWORK, new ServerScheme({
    masumi: {
      seller: seller.signer,
      ...(claim ? { agentIdentifier: claim } : {}),
      // Commit the escrow's input_hash to the job input. The body was validated
      // before the payment gate, so it is well-formed here.
      commitment: ({ transportContext }) => {
        const body = parseJobInput((transportContext as HTTPTransportContext).request.adapter.getBody?.()) as JobInput;
        return [{ name: "body", canonicalization: "jcs", mediaType: "application/json", content: body }];
      },
    },
  }));
  server.onVerifyFailure(async ({ error }) => { console.warn(`[x402 verify ${path}] ${error.message}`); });
  server.onSettleFailure(async ({ error }) => { console.warn(`[x402 settle ${path}] ${error.message}`); });
  const resource = `${publicUrl()}${path}`;
  const http = new x402HTTPResourceServer(server, {
    [`POST ${path}`]: {
      // The URL buyers check against the registry's api_base_url (public, not localhost).
      resource,
      accepts: {
        // "exact": pay exactly `price`. payTo is Masumi's escrow, not the seller.
        // maxTimeoutSeconds (300) becomes the offer's pay-by window.
        scheme: "exact", network: NETWORK, payTo: ESCROW_ADDRESS, maxTimeoutSeconds: 300, price,
        // "masumi" makes @x402/cardano issue escrow terms (datum fields, seller signature)
        // instead of a plain transfer. The buyer pays the network fee.
        extra: { assetTransferMethod: "masumi", areFeesSponsored: false },
      },
      description: "Masumi agent job paid into escrow", mimeType: "application/json",
    },
  });
  return { path, price, resource, registered: Boolean(claim), server, http };
}

/** The registered offer (1 tUSDM by default) and, optionally, an unlisted tADA offer. */
const offers = [
  x402Offer("/x402/start_job", { amount: priceUnits.toString(), asset: TUSDM_X402_ASSET }, agentIdentifier),
  ...(adaPriceLovelace ? [x402Offer("/x402/start_job/ada", { amount: adaPriceLovelace.toString(), asset: "lovelace" }, undefined)] : []),
];

/**
 * Records a paid x402 job. @x402/express calls the route handler after
 * verifying the payment but **before** settling it, so this must not touch the
 * chain: the watcher picks the job up once the lock is visible.
 */
function x402Job(req: Request): Job {
  // PAYMENT-SIGNATURE is the x402 v2 header, the only one this middleware verifies; the X-PAYMENT fallback is defensive.
  const payment = decodePaymentSignatureHeader((req.get("PAYMENT-SIGNATURE") ?? req.get("X-PAYMENT"))!);
  const { txHash } = decodeCardanoTransaction(String(payment.payload.transaction));
  const existing = jobsByTx.get(txHash);
  if (existing) return existing; // a retry of the same payment
  const extra = payment.accepted.extra as unknown as CardanoExtraMasumi;
  const { terms } = extra;
  // The input is what the buyer paid for (the signed commitment), not this request's body.
  const input = extra.inputCommitment.parts[0].content as JobInput;
  const job: Job = {
    id: randomUUID(), path: "x402", status: "awaiting_payment", input,
    // What the escrow datum must say: exactly the terms this agent signed (see lockMatch.ts).
    expected: {
      sellerAddress: terms.sellerAddress, referenceKey: extra.referenceKey, referenceSignature: extra.referenceSignature,
      sellerNonce: terms.sellerNonce, buyerNonce: terms.buyerNonce, agentIdentifier: terms.agentIdentifier ?? "",
      inputHash: terms.inputHash, payByTime: BigInt(terms.payByTime), submitResultTime: BigInt(terms.submitResultTime),
      unlockTime: BigInt(terms.unlockTime), externalDisputeUnlockTime: BigInt(terms.externalDisputeUnlockTime),
      unit: payment.accepted.asset, amount: BigInt(payment.accepted.amount), txHash,
    },
    // The same fields a MIP-003 start_job response carries, so both paths look alike to buyers.
    terms: {
      blockchainIdentifier: extra.blockchainIdentifier, agentIdentifier: terms.agentIdentifier, sellerVKey: paymentKeyHash(terms.sellerAddress),
      identifierFromPurchaser: input.identifier_from_purchaser, input_hash: terms.inputHash,
      payByTime: Number(terms.payByTime), submitResultTime: Number(terms.submitResultTime),
      unlockTime: Number(terms.unlockTime), externalDisputeUnlockTime: Number(terms.externalDisputeUnlockTime),
    },
    lockTx: txHash,
  };
  jobs.set(job.id, job);
  jobsByTx.set(txHash, job);
  return job;
}

// ---------------------------------------------------------------- watcher
//
// Every 10 s: for each job still awaiting payment, look for its lock in the
// escrow, check it against the signed terms, run the task and submit the
// result hash (vested_pay redeemer SubmitResult) before submit_result_time.

/** Give up this long before submit_result_time: SubmitResult needs a validity window that ends before it. */
const SUBMIT_MARGIN_MS = 5 * 60_000;
/** Allowance for chain time vs local clock and Blockfrost indexing lag. */
const PAY_BY_MARGIN_MS = 5 * 60_000;
const logged = new Set<string>();

/**
 * Finds locks for waiting jobs, runs the task and submits the result hash.
 * Errors before the submission are retried on the next tick until the
 * deadline; once the node accepted the SubmitResult, the job is completed.
 */
async function watch() {
  pruneJobs();
  const waiting = [...jobs.values()].filter(j => j.status === "awaiting_payment");
  if (!waiting.length) return;
  // Standard (Sokosumi) jobs: one scan of the tUSDM-holding escrow UTxOs, indexed by seller nonce.
  let byNonce = new Map<string, EscrowUtxo[]>();
  if (waiting.some(j => !j.expected.txHash)) {
    // A failed scan only delays standard jobs; x402 jobs and deadlines still advance.
    try { byNonce = Map.groupBy(await chain.scanEscrow(), u => u.datum?.sellerNonce ?? ""); }
    catch (error) { console.error("[watcher] escrow scan failed:", error instanceof Error ? error.message : error); }
  }
  for (const job of waiting) {
    // One job's failure (e.g. Blockfrost hiccup) must never skip the others.
    try { await advance(job, byNonce); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (job.resultTx) { console.warn(`[job ${job.id}] SubmitResult ${job.resultTx} not confirmed yet: ${message}`); continue; }
      Object.assign(job, { status: "awaiting_payment", error: message });
      console.error(`[job ${job.id}] will retry: ${message}`);
    }
  }
}

async function advance(job: Job, byNonce: Map<string, EscrowUtxo[]>) {
  if (Date.now() > Number(job.expected.submitResultTime) - SUBMIT_MARGIN_MS) {
    Object.assign(job, { status: "failed", error: job.error ?? "No matching escrow lock arrived in time." });
    return;
  }
  // x402 jobs: the lock is an output of the transaction the facilitator verified.
  const candidates = job.expected.txHash ? await chain.locksOfTx(job.expected.txHash) : byNonce.get(job.expected.sellerNonce) ?? [];
  for (const candidate of candidates) {
    const key = `${job.id}:${candidate.txHash}#${candidate.outputIndex}`;
    const reason = lockMismatch(candidate, job.expected);
    if (reason && !logged.has(key)) { logged.add(key); console.warn(`[job ${job.id}] ignoring escrow UTxO ${candidate.txHash}#${candidate.outputIndex}: ${reason}`); }
  }
  const lock = findLock(candidates, job.expected);
  if (!lock) {
    // An x402 lock is only valid until payByTime; if it has not landed by then, it never will.
    if (job.expected.txHash && Date.now() > Number(job.expected.payByTime) + PAY_BY_MARGIN_MS) {
      Object.assign(job, { status: "failed", error: "The payment transaction never landed before its pay-by time." });
    }
    return;
  }
  Object.assign(job, { status: "running", lockTx: lock.txHash, lock: lockSnapshot(lock) });
  const result = runTask(job.input.input_data);
  const hash = resultHash(job.input.identifier_from_purchaser, result);
  await chain.submitResult(lock, hash, ({ txHash, sellerCooldownTime }) => {
    // The node accepted it: the result is on its way on chain, report it now.
    Object.assign(job, { status: "completed", result, resultHash: hash, resultTx: txHash, sellerCooldownTime, error: undefined });
    console.log(`[job ${job.id}] completed; SubmitResult ${txHash}`);
  });
}

/** Forgets finished jobs a day after their dispute window, and caps the store. */
function pruneJobs() {
  const cutoff = Date.now() - 24 * 3600_000;
  for (const job of jobs.values()) {
    if (job.status !== "running" && Number(job.expected.externalDisputeUnlockTime) < cutoff) {
      jobs.delete(job.id);
      if (job.expected.txHash) jobsByTx.delete(job.expected.txHash);
    }
  }
}
let watching = false;
setInterval(() => {
  if (watching) return;
  watching = true;
  watch().catch(error => console.error("[watcher]", error instanceof Error ? error.message : error)).finally(() => { watching = false; });
}, 10_000);

// ---------------------------------------------------------------- HTTP

const app = express();
app.use(express.json({ limit: "16kb" }));
const validBody = (req: Request, res: Response, next: NextFunction) => {
  const parsed = parseJobInput(req.body);
  if (typeof parsed === "string") res.status(400).json({ error: parsed });
  else next();
};

app.get("/availability", (_req, res) => {
  res.json({ status: "available", type: "masumi-agent", agentIdentifier, message: "Reverses and upper-cases text." });
});
app.get("/input_schema", (_req, res) => { res.json(INPUT_SCHEMA); });

const MAX_OPEN_JOBS = 500;
const tooBusy = () => [...jobs.values()].filter(j => j.status === "awaiting_payment").length >= MAX_OPEN_JOBS;

/**
 * MIP-003 start_job, standard Masumi path. Signs purchase terms the way the
 * Masumi Payment Service would (masumi.ts standardTerms); the buyer's own
 * payment node then locks the funds. Nothing is paid in this request.
 */
app.post("/start_job", validBody, async (req, res, next) => {
  if (tooBusy()) { res.status(503).json({ error: "Too many open jobs; try again later." }); return; }
  try {
    const input = parseJobInput(req.body) as JobInput;
    const { response, sellerNonce, referenceKey, referenceSignature } = await standardTerms({
      identifierFromPurchaser: input.identifier_from_purchaser, inputData: input.input_data,
      agentIdentifier, sellerAddress: seller.address, sign: seller.signTerms,
    });
    const job: Job = {
      id: randomUUID(), path: "standard", status: "awaiting_payment", input, terms: response,
      expected: {
        sellerAddress: seller.address, referenceKey, referenceSignature, sellerNonce,
        buyerNonce: input.identifier_from_purchaser, agentIdentifier, inputHash: response.input_hash,
        payByTime: BigInt(response.payByTime), submitResultTime: BigInt(response.submitResultTime),
        unlockTime: BigInt(response.unlockTime), externalDisputeUnlockTime: BigInt(response.externalDisputeUnlockTime),
        unit: TUSDM_UNIT, amount: priceUnits,
      },
    };
    jobs.set(job.id, job);
    res.json({ id: job.id, status: job.status, ...response });
  } catch (error) { next(error); }
});

// x402 routes: validate the body, cap open jobs, then the x402 payment gate.
// Without PAYMENT-SIGNATURE the gate answers 402 with a fresh signed offer; with
// it, the gate verifies, runs the handler, then settles before the response is sent.
for (const offer of offers) {
  const gate = paymentMiddlewareFromHTTPServer(offer.http, undefined, undefined, false);
  app.post(offer.path, validBody, (_req, res, next) => {
    if (tooBusy()) res.status(503).json({ error: "Too many open jobs; try again later." }); else next();
  }, gate, (req, res) => { res.json(view(x402Job(req))); });
}

/** MIP-003 status: awaiting_payment | running | completed | failed, plus the result once completed. */
app.get("/status", (req, res) => {
  const job = jobs.get(String(req.query.job_id));
  if (!job) { res.status(404).json({ error: "Unknown job_id" }); return; }
  res.json({ job_id: job.id, status: job.status, ...(job.result ? { result: job.result } : {}) });
});
/** Demo extras for the UI: the full job, looked up by id or by the lock transaction. */
app.get("/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (job) res.json(view(job)); else res.status(404).json({ error: "Unknown job" });
});
app.get("/jobs/by-tx/:hash", (req, res) => {
  const job = jobsByTx.get(req.params.hash);
  if (job) res.json(view(job)); else res.status(404).json({ error: "Unknown transaction" });
});
app.get("/demo/config", (_req, res) => {
  res.json({
    agentIdentifier, sellerAddress: seller.address, escrowAddress: ESCROW_ADDRESS,
    offers: offers.map(o => ({ path: o.path, amount: o.price.amount, asset: o.price.asset, resource: o.resource, registered: o.registered })),
    sokosumi: { enabled: Boolean(sokosumi) },
  });
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[agent]", error instanceof Error ? error.message : error);
  res.status(500).json({ error: "The agent could not process this request." });
});

for (const offer of offers) {
  await offer.server.initialize();
  await offer.http.initialize();
}
if (sokosumi) startSokosumiProxy(sokosumi);
app.listen(port, () => {
  console.log(`Masumi agent on http://localhost:${port} (public: ${publicUrl()})`);
  console.log(`  agent ${agentIdentifier}\n  seller ${seller.address}`);
});

// ---------------------------------------------------------------- Sokosumi (operator only)

/**
 * Lets the demo UI hire this agent through Sokosumi with the operator's API
 * key. It listens on 127.0.0.1 on its own port, which the public tunnel does
 * not forward. Host and Origin checks stop web pages in the operator's browser
 * (DNS rebinding, cross-site posts) from spending credits or reading results.
 */
function startSokosumiProxy(config: NonNullable<typeof sokosumi>) {
  const client = createSokosumi(config);
  const hosts = new Set([`127.0.0.1:${config.proxyPort}`, `localhost:${config.proxyPort}`]);
  const origins = new Set(["http://localhost:5174", "http://127.0.0.1:5174"]);
  const uiHosts = new Set(["localhost:5174", "127.0.0.1:5174"]);
  const loopback = (ip: string) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ip.trim());
  const proxy = express();
  proxy.disable("x-powered-by");
  proxy.use((req, res, next) => {
    const origin = req.get("Origin");
    // Through Vite, also check who Vite was talking to (a LAN client if Vite runs with --host).
    const forwardedHost = req.get("X-Forwarded-Host");
    const forwardedFor = req.get("X-Forwarded-For");
    if (!hosts.has(req.get("Host") ?? "") || (origin !== undefined && !origins.has(origin))
      || (forwardedHost !== undefined && !uiHosts.has(forwardedHost))
      || (forwardedFor !== undefined && !forwardedFor.split(",").every(loopback))) {
      res.status(403).json({ error: "The Sokosumi proxy only serves the local demo UI." }); return;
    }
    if (req.method === "POST" && !req.is("application/json")) { res.status(415).json({ error: "Send application/json." }); return; }
    next();
  });
  proxy.use(express.json({ limit: "4kb" }));
  proxy.post("/sokosumi/hire", async (req, res) => {
    const text = (req.body as { text?: unknown } | undefined)?.text;
    if (typeof text !== "string" || !text.trim() || text.length > 500) { res.status(400).json({ error: "text must be 1-500 characters" }); return; }
    // Never retried: a second call would be a second paid job.
    try { res.status(201).json(await client.hire(text, config.maxCredits)); }
    catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
  proxy.get("/sokosumi/jobs/:id", async (req, res) => {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(req.params.id)) { res.status(400).json({ error: "Invalid job id" }); return; }
    try { res.json(await client.job(req.params.id)); }
    catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
  proxy.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(400).json({ error: error instanceof Error ? error.message : "Bad request" });
  });
  proxy.listen(config.proxyPort, "127.0.0.1", () => {
    console.log(`  Sokosumi proxy on http://127.0.0.1:${config.proxyPort} (local only)`);
  });
}
