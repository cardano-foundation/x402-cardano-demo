/**
 * The UI's step model and the pure helpers behind the inspector. Every step
 * says who acts and why, and carries the real data it produced.
 */
import type { MasumiDatumView } from "@x402/cardano";

export type Actor = "buyer" | "agent" | "facilitator" | "escrow" | "registry" | "sokosumi";
export type StepStatus = "pending" | "active" | "done" | "failed" | "skipped";

export interface Step {
  id: string;
  title: string;
  actor: Actor;
  /** One or two sentences: what happens here and why. */
  explain: string;
  status: StepStatus;
  /** What a developer should notice in the data. */
  lookFor?: string;
  data?: unknown;
  links?: Array<{ label: string; href: string }>;
  /** Part of a replayed example run: simulated, no money moves, no real links. */
  example?: boolean;
  /** When the step became active and when it finished (ms), for the timeline. */
  startedAt?: number;
  endedAt?: number;
}

export const ACTORS: Record<Actor, { name: string; role: string }> = {
  buyer: { name: "Buyer", role: "You. Your wallet signs the payment into escrow." },
  agent: { name: "Agent (seller)", role: "Does the work, signs the payment terms, and later puts the result hash on chain." },
  facilitator: { name: "Facilitator", role: "x402 verifier and broadcaster; here it runs inside the agent and holds no keys." },
  escrow: { name: "Masumi escrow", role: "The vested_pay smart contract holding the money until the seller may collect." },
  registry: { name: "Masumi registry", role: "An on-chain NFT per agent with its name, URL and price; buyers check offers against it." },
  sokosumi: { name: "Sokosumi", role: "Marketplace; it hires agents with its own payment node and bills you in credits." },
};

/** Returns a copy of `steps` with one step patched. */
export const updateStep = (steps: Step[], id: string, patch: Partial<Step>): Step[] =>
  steps.map(step => step.id === id ? { ...step, ...patch } : step);

/** JSON-friendly copy: bigints become strings (JSON.stringify cannot print them). */
export function displayable(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(displayable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, displayable(v)]));
  return value;
}

const STATES = ["FundsLocked", "ResultSubmitted", "RefundRequested", "Disputed", "WithdrawAuthorized", "RefundAuthorized"];
const time = (ms: bigint) => ms === 0n ? "0" : `${ms} (${new Date(Number(ms)).toISOString().replace(".000Z", "Z")})`;
const address = (a: MasumiDatumView["buyer"] | null) =>
  a ? `payment ${a.payment.isScript ? "script" : "key"} ${a.payment.hash}${a.stake ? `, stake ${a.stake.hash}` : ""}` : "None";
const bytes = (hex: string) => hex === "" ? "(empty)" : hex;

export interface DatumRow { index: number; field: string; value: string; decidedBy: "buyer" | "seller" | "seller (SubmitResult)" | "buyer (refund)" | "contract"; meaning: string }

/** The 19 fields of the vested_pay V2 datum, in on-chain order, with what each one means. */
export function datumRows(d: MasumiDatumView): DatumRow[] {
  const rows: Array<Omit<DatumRow, "index">> = [
    { field: "buyer", value: address(d.buyer), decidedBy: "buyer", meaning: "Who paid; refunds and the collateral return go here." },
    { field: "buyer_return_address", value: address(d.buyerReturnAddress), decidedBy: "buyer", meaning: "Optional other address for the buyer's refund." },
    { field: "seller", value: address(d.seller), decidedBy: "seller", meaning: "The agent's key; only it can submit the result and withdraw." },
    { field: "seller_return_address", value: address(d.sellerReturnAddress), decidedBy: "seller", meaning: "Optional payout address; this demo requires None." },
    { field: "reference_key", value: bytes(d.referenceKey), decidedBy: "seller", meaning: "COSE key of the seller's signature over the terms." },
    { field: "reference_signature", value: bytes(d.referenceSignature), decidedBy: "seller", meaning: "The seller's CIP-8 signature; also makes each lock unique." },
    { field: "seller_nonce", value: bytes(d.sellerNonce), decidedBy: "seller", meaning: "Random per quote; the agent uses it to find this job's lock." },
    { field: "buyer_nonce", value: bytes(d.buyerNonce), decidedBy: "seller", meaning: "The buyer's purchase identifier, echoed in the seller's signed terms (empty on the x402 path)." },
    { field: "agent_identifier", value: bytes(d.agentIdentifier), decidedBy: "seller", meaning: "Registry NFT of the agent; empty for an unlisted offer." },
    { field: "collateral_return_lovelace", value: d.collateralReturnLovelace.toString(), decidedBy: "buyer", meaning: "Deposit topping the output up to min-UTxO; returned to the buyer." },
    { field: "input_hash", value: bytes(d.inputHash), decidedBy: "seller", meaning: "Commitment to the job input the buyer asked for." },
    { field: "result_hash", value: bytes(d.resultHash), decidedBy: "seller (SubmitResult)", meaning: "Empty until the agent submits sha256(id;result) on chain." },
    { field: "pay_by_time", value: time(d.payByTime), decidedBy: "seller", meaning: "The lock must land before this (POSIX ms)." },
    { field: "submit_result_time", value: time(d.submitResultTime), decidedBy: "seller", meaning: "The agent must submit the result before this, or the buyer can refund." },
    { field: "unlock_time", value: time(d.unlockTime), decidedBy: "seller", meaning: "From here the seller can withdraw the payment." },
    { field: "external_dispute_unlock_time", value: time(d.externalDisputeUnlockTime), decidedBy: "seller", meaning: "End of the dispute window." },
    { field: "seller_cooldown_time", value: time(d.sellerCooldownTime), decidedBy: "seller (SubmitResult)", meaning: "Set by SubmitResult: upper validity bound + 7 min." },
    { field: "buyer_cooldown_time", value: time(d.buyerCooldownTime), decidedBy: "buyer (refund)", meaning: "Set when the buyer acts (refund request); 0 here." },
    { field: "state", value: `${d.state} (${STATES[Number(d.state)] ?? "unknown"})`, decidedBy: "contract", meaning: "Where the escrow is in its state machine." },
  ];
  return rows.map((row, index) => ({ index, ...row }));
}
