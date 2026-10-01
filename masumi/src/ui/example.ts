/**
 * "Replay an example purchase": the real x402 flow module (`runX402`) run
 * against a simulated agent and a simulated wallet, so anyone can explore every
 * step without a wallet. Nothing touches a network or a chain. Hashes are
 * obviously fake repeated patterns, and the UI shows no explorer links for them.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { buildMasumiLockDatum, parseMasumiLockDatum, type ClientCardanoSigner } from "@x402/cardano";
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { ESCROW_ADDRESS, REGISTRY_POLICY_ID, TUSDM_UNIT, TUSDM_X402_ASSET } from "../constants.js";
import { displayable } from "./steps.js";
import type { JobView, Offer, SignerContext, X402Deps } from "./x402Flow.js";

/** Addresses of the public test mnemonic ("test … junk"): nobody's funds. */
const SELLER = "addr_test1qq4jrrcfzylccwgqu3su865es52jkf7yzrdu9cw3z84nycnn3zz9lvqj7vs95tej896xkekzkufhpuk64ja7pga2g8ksdf8km4";
const BUYER = "addr_test1qpzdzgj2lgsemgtzvaft77stwn5k9scduwdglmphq3kpdft09083trxjn8nnmder6h37nuwlpqty5ymnxhw7zjp8fv8q8s9l8z";
export const EXAMPLE_LOCK_TX = "e0".repeat(32);
export const EXAMPLE_RESULT_TX = "f0".repeat(32);
const AGENT_ID = `${REGISTRY_POLICY_ID}10${"ee".repeat(28)}000000`;
const hex = (bytes: Uint8Array) => [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
const sha = (text: string) => hex(sha256(new TextEncoder().encode(text)));

export const EXAMPLE_OFFER: Offer = { path: "/x402/start_job", amount: "1000000", asset: TUSDM_X402_ASSET, resource: "https://agent.example/x402/start_job", registered: true };

/**
 * Simulated agent + wallet for `runX402`. `pace` is the pause between polls
 * (ms); once `signal` aborts, every simulated wait rejects so the replay stops.
 */
export function exampleDeps(pace = 900, signal?: AbortSignal): Omit<X402Deps, "emit"> {
  const now = Date.now();
  const wait = (ms: number) => new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("aborted")); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
  });
  const identifier = "a1".repeat(10);
  const text = "hello masumi";
  const input = { identifier_from_purchaser: identifier, input_data: { text } };
  const terms = {
    version: "1", paymentType: "Web3CardanoV2", sellerAddress: SELLER, sellerNonce: "5e".repeat(32), buyerNonce: "", agentIdentifier: AGENT_ID,
    inputHash: sha(`masumi-commitment:${JSON.stringify(input)}`),
    payByTime: String(now + 5 * 60_000), submitResultTime: String(now + 20 * 60_000), unlockTime: String(now + 40 * 60_000), externalDisputeUnlockTime: String(now + 60 * 60_000),
  };
  const extra = {
    assetTransferMethod: "masumi", areFeesSponsored: false, terms,
    inputCommitment: { version: "1", algorithm: "sha256", parts: [{ name: "body", canonicalization: "jcs", mediaType: "application/json", content: input, digest: terms.inputHash }], digest: terms.inputHash },
    referenceKey: "a4".repeat(20), referenceSignature: "84".repeat(40), blockchainIdentifier: "b1".repeat(60),
  };
  const required = { x402Version: 2, resource: { url: EXAMPLE_OFFER.resource, description: "Masumi agent job paid into escrow" },
    accepts: [{ scheme: "exact", network: "cardano:preprod", payTo: ESCROW_ADDRESS, asset: TUSDM_X402_ASSET, amount: "1000000", maxTimeoutSeconds: 300, extra }] };
  const datum = parseMasumiLockDatum(buildMasumiLockDatum({
    buyerAddress: BUYER, sellerAddress: SELLER, referenceKey: extra.referenceKey, referenceSignature: extra.referenceSignature,
    sellerNonce: terms.sellerNonce, buyerNonce: "", agentIdentifier: AGENT_ID, collateralReturnLovelace: 0n, inputHash: terms.inputHash,
    payByTime: BigInt(terms.payByTime), submitResultTime: BigInt(terms.submitResultTime), unlockTime: BigInt(terms.unlockTime), externalDisputeUnlockTime: BigInt(terms.externalDisputeUnlockTime),
  }))!;
  const lockedLovelace = "1452160";
  const result = [...text].reverse().join("").toUpperCase();
  const resultHash = sha(`${identifier};${result}`);
  const cooldown = BigInt(now + 3 * 60_000 + 420_000);
  const lock = { ref: `${EXAMPLE_LOCK_TX}#0`, lovelace: lockedLovelace, tokens: { [TUSDM_UNIT]: "1000000" }, datum: displayable(datum) };
  const jobs: JobView[] = [
    { id: "example-job", status: "awaiting_payment" },
    { id: "example-job", status: "running", lockTx: EXAMPLE_LOCK_TX, lock },
    { id: "example-job", status: "completed", lockTx: EXAMPLE_LOCK_TX, lock, result, resultHash, resultTx: EXAMPLE_RESULT_TX,
      sellerCooldownTime: String(cooldown), unlockTime: Number(terms.unlockTime) },
  ];
  let poll = 0;

  const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { ...init, headers: { "Content-Type": "application/json", ...init.headers } });
  return {
    api: async (path, init) => {
      await wait(0);
      if (path.startsWith("/jobs/by-tx/")) return json(jobs[Math.min(poll++, jobs.length - 1)]);
      if (!new Headers(init?.headers).get("PAYMENT-SIGNATURE")) {
        return json({}, { status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required as never) } });
      }
      await wait(pace); // the facilitator broadcasts and waits for a confirmation
      const receipt = { success: true, transaction: EXAMPLE_LOCK_TX, network: "cardano:preprod", payer: BUYER };
      return json({ id: "example-job", status: "awaiting_payment", lockTx: EXAMPLE_LOCK_TX }, { headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader(receipt as never) } });
    },
    createSigner: async (context: SignerContext): Promise<ClientCardanoSigner> => ({
      getAddress: () => BUYER,
      buildAndSignPaymentTransaction: async input => {
        await wait(pace / 2);
        context.onVerified({ termsDigest: "d1".repeat(32), registry: "checked" });
        await wait(pace / 2);
        context.onBuilt({ nonce: `${"c0".repeat(32)}#1`, datum, validTo: terms.payByTime,
          output: { lovelace: lockedLovelace, asset: input.asset, amount: input.amount } });
        return { transaction: "AA==", nonce: `${"c0".repeat(32)}#1` };
      },
    }),
    sleep: ms => wait(Math.min(ms, pace)),
    txHashOf: () => EXAMPLE_LOCK_TX,
    randomHex: () => identifier,
  };
}
