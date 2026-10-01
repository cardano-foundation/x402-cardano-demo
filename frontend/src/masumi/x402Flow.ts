/**
 * The x402 purchase, step by step. Dependencies are injected (HTTP, signer,
 * clock) so the flow runs in unit tests without a browser or wallet; every
 * step reports what happened and the data it produced.
 *
 * The protocol in four HTTP calls (docs/FLOWS.md, "x402 purchase"):
 *   1. POST /x402/start_job                      -> 402 + PAYMENT-REQUIRED (the offer)
 *   2. (local) verify the offer, build and sign the escrow lock; nothing is broadcast
 *   3. POST /x402/start_job + PAYMENT-SIGNATURE  -> 200 + PAYMENT-RESPONSE (after settlement)
 *   4. GET  /jobs/by-tx/<lock tx hash>           -> polled until the result hash is submitted
 */
import { decodeCardanoTransaction, type ClientCardanoSigner, type MasumiDatumView } from "@x402/cardano";
import { ExactCardanoScheme } from "@x402/cardano/exact/client";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { ResourceInfo } from "@x402/core/types";
import { NETWORK, unitKey } from "../../../masumi/src/constants.js";
import type { Step } from "./steps.js";

export interface Offer { path: string; amount: string; asset: string; resource: string; registered: boolean }
export interface JobView {
  id: string; status: "awaiting_payment" | "running" | "completed" | "failed";
  lockTx?: string; resultTx?: string; result?: string; resultHash?: string; sellerCooldownTime?: string; error?: string;
  unlockTime?: number; lock?: { ref: string; lovelace: string; tokens: Record<string, string>; datum: unknown };
}

/** What the signer tells the flow while it works. */
export interface SignerContext {
  commitment: unknown;
  resource?: ResourceInfo;
  onVerified(result: { termsDigest: string; registry: "checked" | "skipped" }): void;
  onBuilt(lock: { nonce: string; output: { lovelace: string; asset: string; amount: string }; datum: MasumiDatumView | null; validTo: string }): void;
}

export interface X402Deps {
  /** `fetch` against the agent (the tab sends it to `${VITE_SERVER_URL}/masumi`, which forwards). */
  api(path: string, init?: RequestInit): Promise<Response>;
  createSigner(context: SignerContext): Promise<ClientCardanoSigner>;
  emit(id: X402StepId, patch: Partial<Step>): void;
  sleep?(ms: number): Promise<void>;
  now?(): number;
  txHashOf?(transactionBase64: string): string;
  randomHex?(bytes: number): string;
}

export type X402StepId = "request" | "verify" | "sign" | "pay" | "settle" | "lock" | "result" | "collect";

export const x402Steps = (offer: Offer): Step[] => [
  { id: "request", actor: "buyer", status: "pending", title: "Ask for the job, get a 402 offer",
    explain: "The UI posts the job to the agent. Without payment, the agent answers HTTP 402 with a PAYMENT-REQUIRED header: price, escrow address and seller-signed Masumi terms.",
    lookFor: "payTo is Masumi's escrow, not the seller. extra.terms holds the deadlines; extra.inputCommitment is your job input." },
  { id: "verify", actor: "buyer", status: "pending", title: "Verify the offer",
    explain: offer.registered
      ? "Before signing anything, the buyer checks the seller's signature over the terms, that the offer commits to this job, and on chain that the agent's registry entry lists this price and URL."
      : "Unlisted offer: the buyer checks the seller's signature and that the offer commits to this job. There is no agent identifier, so the registry check is skipped.",
    lookFor: "termsDigest is what the seller signed; registry says whether the on-chain check ran." },
  { id: "sign", actor: "buyer", status: "pending", title: "Sign the escrow lock",
    explain: "Your wallet signs a transaction that pays the price into the escrow contract with an inline datum: the terms, both parties, and the deadlines. Nobody broadcasts it yet.",
    lookFor: "The datum's 19 fields: who may do what, and when. It is valid only until pay_by_time." },
  { id: "pay", actor: "buyer", status: "pending", title: "Send the payment over HTTP",
    explain: "The UI repeats the same POST, now with a PAYMENT-SIGNATURE header carrying the signed escrow transaction and the accepted offer. This HTTP request is the x402 payment; the wallet never broadcasts anything itself.",
    lookFor: "The PAYMENT-SIGNATURE header, decoded. The response only arrives after the facilitator has settled (next step)." },
  { id: "settle", actor: "facilitator", status: "pending", title: "The facilitator verifies and broadcasts",
    explain: "Inside the agent, the facilitator re-verifies the signed transaction, broadcasts it and waits for a confirmation. Only then does the agent answer the paid request, with the receipt in the PAYMENT-RESPONSE header.",
    lookFor: "PAYMENT-RESPONSE, decoded: its transaction is your lock. The UI follows the job by that hash even if this long request drops." },
  { id: "lock", actor: "agent", status: "pending", title: "The agent finds the lock on chain",
    explain: "The agent watches the escrow for exactly this transaction and accepts it only if every datum field it signed matches (spoof protection). Then it runs the job.",
    lookFor: "state 0 (FundsLocked), result_hash empty, the value paid." },
  { id: "result", actor: "agent", status: "pending", title: "The agent submits the result hash",
    explain: "The agent spends the lock with the SubmitResult redeemer: same tokens (lovelace may grow for the larger datum), same datum, except result_hash, seller cooldown and state ResultSubmitted. The result itself stays off chain.",
    lookFor: "result_hash = sha256(identifier;result) (MIP-004). Shown as sent: the agent reports node acceptance, not an on-chain read." },
  { id: "collect", actor: "agent", status: "pending", title: "Seller collects after the unlock time",
    explain: "Agent-driven and outside this purchase: once the result is on chain, your part is done. After unlock_time the seller runs npm run collect to withdraw; your refundable deposit (if any) is paid back in that same transaction.",
    lookFor: "unlock_time: from then on the seller may withdraw. This page does not watch the withdrawal." },
];

const NEVER_RECORDED = "The agent never recorded this payment. Check the lock transaction on the explorer: if it is not there, it expired and no funds moved; if it is, the agent lost the job (for example after a restart) and the funds wait in escrow for a refund.";

/** Runs one purchase. Resolves with the completed job; rejects with a readable message. */
export async function runX402(offer: Offer, text: string, deps: X402Deps): Promise<JobView> {
  const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const txHashOf = deps.txHashOf ?? (tx => decodeCardanoTransaction(tx).txHash);
  const randomHex = deps.randomHex ?? (bytes => [...crypto.getRandomValues(new Uint8Array(bytes))].map(b => b.toString(16).padStart(2, "0")).join(""));
  let current: X402StepId = "request";
  const step = (id: X402StepId, patch: Partial<Step>) => { if (patch.status === "active") current = id; deps.emit(id, patch); };

  try {
    // 1. The unpaid request (a MIP-003 start_job body). The whole body becomes
    //    the offer's input commitment (hashed into input_hash), and
    //    identifier_from_purchaser is part of the result hash later.
    const body = { identifier_from_purchaser: randomHex(10), input_data: { text } };
    const init: RequestInit = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
    step("request", { status: "active" });
    const first = await deps.api(offer.path, init);
    if (first.status !== 402) throw new Error(`Expected a payment offer, got HTTP ${first.status}: ${await first.text()}`);

    // 2. The x402 client picks an offer, then calls our signer, which verifies
    //    the Masumi terms and builds the lock (see cip30Signer.ts). The resource
    //    is read lazily: it is only known once the 402 below is parsed.
    let resource: ResourceInfo | undefined;
    const signer = await deps.createSigner({
      commitment: body,
      get resource() { return resource; },
      onVerified: result => { step("verify", { status: "done", data: result }); step("sign", { status: "active" }); },
      onBuilt: lock => step("sign", { status: "active", data: lock }),
    });
    const http = new x402HTTPClient(x402Client.fromConfig({
      schemes: [{ network: NETWORK, client: new ExactCardanoScheme(signer) }],
      // Neither Masumi tUSDM nor lovelace is one of the library's default
      // assets, so allow exactly the chosen asset, capped at its price.
      spendControls: { allowedAssets: [{ network: NETWORK, asset: offer.asset, maxAmountPerPayment: offer.amount }] },
      // Pay only the chosen price, only into Masumi escrow.
      policies: [(_v, offers) => offers.filter(o => o.extra?.assetTransferMethod === "masumi" && unitKey(o.asset) === unitKey(offer.asset) && o.amount === offer.amount)],
    }));
    const required = http.getPaymentRequiredResponse(name => first.headers.get(name));
    resource = required.resource;
    step("request", { status: "done", data: { request: body, paymentRequired: required } });

    step("verify", { status: "active" });
    const payload = await http.createPaymentPayload(required);
    const txHash = txHashOf(String(payload.payload.transaction));
    step("sign", { status: "done", links: [{ label: "Lock transaction (after broadcast)", href: `https://preprod.cardanoscan.io/transaction/${txHash}` }] });

    // 3. The paid request: the same POST plus PAYMENT-SIGNATURE (base64 JSON of
    //    the accepted offer and the signed transaction). The agent answers only
    //    after the facilitator broadcast the lock and saw it confirmed.
    step("pay", { status: "active", data: { txHash, paymentSignature: payload } });
    // Fire the paid request; its receipt fills this step whenever it arrives.
    let rejected: string | undefined;
    void deps.api(offer.path, { ...init, headers: { ...init.headers as Record<string, string>, ...http.encodePaymentSignatureHeader(payload) } })
      .then(async response => {
        if (!response.ok) {
          rejected = `The agent did not accept the payment (HTTP ${response.status}): ${(await response.text()).slice(0, 300) || "no details"}`;
          step("settle", { data: { txHash, paymentSignature: payload, rejected } });
          return;
        }
        let receipt: unknown;
        try { receipt = http.getPaymentSettleResponse(name => response.headers.get(name)); } catch { receipt = "unreadable PAYMENT-RESPONSE header"; }
        step("settle", { status: "done", data: { txHash, paymentSignature: payload, receipt, job: await response.json().catch(() => undefined) } });
      })
      .catch(() => step("settle", { data: { txHash, paymentSignature: payload, note: "No response to the paid request (connection dropped or timed out). Following the transaction by hash instead." } }));

    // 4. Follow the job by the lock's transaction hash, which the buyer knows
    //    before broadcast. This survives a dropped paid request.
    let lockShown = false;
    // The request is on its way; from here the facilitator works until it answers.
    step("pay", { status: "done" });
    step("settle", { status: "active", data: { txHash, paymentSignature: payload } });
    const payBy = Number((payload.accepted.extra as { terms?: { payByTime?: string } } | undefined)?.terms?.payByTime ?? now() + 600_000);
    let pollFailures = 0;
    for (;;) {
      await sleep(5000);
      let response: Response, job: JobView;
      try {
        response = await deps.api(`/jobs/by-tx/${txHash}`);
        if (!response.ok) {
          pollFailures = 0;
          if (rejected) throw new Error(rejected);
          if (now() > payBy + 120_000) throw new Error(NEVER_RECORDED);
          continue;
        }
        job = await response.json() as JobView;
        pollFailures = 0;
      } catch (error) {
        // Real funds may be in flight: ride out a few network blips, but not the flow's own verdicts.
        if (error instanceof Error && (error.message === rejected || error.message === NEVER_RECORDED)) throw error;
        if (++pollFailures >= 6) throw new Error(`Lost contact with the agent (${error instanceof Error ? error.message : error}). The payment ${txHash} may still complete; check the agent's log.`);
        continue;
      }
      // Steps only move forward: once the lock is shown as found, later polls never undo it.
      if (job.lock && !lockShown) { lockShown = true; step("lock", { status: "done", data: job.lock }); }
      else if (!lockShown && job.status === "running") step("lock", { status: "active" });
      if (job.status === "completed") {
        step("result", { status: "done", data: { resultTx: job.resultTx, resultHash: job.resultHash, sellerCooldownTime: job.sellerCooldownTime, result: job.result, state: "SubmitResult sent (awaiting confirmation)" },
          links: job.resultTx ? [{ label: "SubmitResult transaction", href: `https://preprod.cardanoscan.io/transaction/${job.resultTx}` }] : [] });
        // Nothing to wait for: collecting is the seller's own later action (npm run collect).
        step("collect", { status: "done", data: { unlockTime: job.unlockTime, command: "npm run collect", by: "the seller (agent operator), after unlock_time" } });
        return job;
      }
      if (job.status === "failed") throw new Error(job.error ?? "The job failed.");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    step(current, { status: "failed", data: { error: message } });
    throw new Error(message);
  }
}
