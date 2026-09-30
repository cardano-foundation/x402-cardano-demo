/**
 * Decides whether an escrow UTxO is the payment for a job. The seller nonce is
 * public, so anyone can create a UTxO that carries it. A lock is accepted only
 * if every datum field the seller decided equals what the seller signed.
 * The buyer may choose only `buyer`, `buyer_return_address` and
 * `collateral_return_lovelace`, and the latter must be covered by the UTxO.
 */
import { addressCredentials, type MasumiDatumView } from "@x402/cardano";
import { unitKey } from "./constants.js";

/** What the seller signed for one job, on either path. */
export interface ExpectedLock {
  sellerAddress: string;
  referenceKey: string;
  referenceSignature: string;
  sellerNonce: string;
  buyerNonce: string;
  agentIdentifier: string;
  inputHash: string;
  payByTime: bigint;
  submitResultTime: bigint;
  unlockTime: bigint;
  externalDisputeUnlockTime: bigint;
  /** Price unit in any form (`policy.name`, `policyname`, `lovelace`). */
  unit: string;
  amount: bigint;
  /** x402 jobs: the transaction the facilitator verified. */
  txHash?: string;
}

/** An escrow UTxO as read from the chain. */
export interface EscrowUtxo {
  txHash: string;
  outputIndex: number;
  datum: MasumiDatumView | null;
  lovelace: bigint;
  /** Native tokens keyed by `policyId ++ assetName`. */
  tokens: Record<string, bigint>;
  hasReferenceScript: boolean;
  /** The chain library's own UTxO object, used to spend it. Opaque here. */
  raw?: unknown;
}

const sameCredentials = (a: MasumiDatumView["seller"], address: string) => {
  const b = addressCredentials(address);
  return a.payment.hash === b.payment.hash && a.payment.isScript === b.payment.isScript
    && a.stake?.hash === b.stake?.hash && a.stake?.isScript === b.stake?.isScript && !a.pointer && !b.pointer;
};

/** Returns `null` when the UTxO pays for the job, otherwise why it does not. */
export function lockMismatch(utxo: EscrowUtxo, job: ExpectedLock): string | null {
  const d = utxo.datum;
  if (!d) return "no parsable vested_pay datum";
  if (job.txHash && utxo.txHash !== job.txHash) return "not the verified lock transaction";
  if (utxo.hasReferenceScript) return "carries a reference script";
  const checks: Array<[boolean, string]> = [
    [sameCredentials(d.seller, job.sellerAddress), "seller"],
    [d.sellerReturnAddress === null, "seller_return_address"],
    [d.referenceKey === job.referenceKey, "reference_key"],
    [d.referenceSignature === job.referenceSignature, "reference_signature"],
    [d.sellerNonce === job.sellerNonce, "seller_nonce"],
    [d.buyerNonce === job.buyerNonce, "buyer_nonce"],
    [d.agentIdentifier === job.agentIdentifier, "agent_identifier"],
    [d.inputHash === job.inputHash, "input_hash"],
    [d.resultHash === "", "result_hash"],
    [d.payByTime === job.payByTime, "pay_by_time"],
    [d.submitResultTime === job.submitResultTime, "submit_result_time"],
    [d.unlockTime === job.unlockTime, "unlock_time"],
    [d.externalDisputeUnlockTime === job.externalDisputeUnlockTime, "external_dispute_unlock_time"],
    [d.sellerCooldownTime === 0n, "seller_cooldown_time"],
    [d.buyerCooldownTime === 0n, "buyer_cooldown_time"],
    [d.state === 0n, "state"],
    [d.collateralReturnLovelace >= 0n && d.collateralReturnLovelace <= utxo.lovelace, "collateral_return_lovelace"],
    // Withdraw must pay the buyer back at this address; the tx builder cannot express pointer addresses.
    [!d.buyer.pointer && !d.buyerReturnAddress?.pointer, "buyer (pointer address)"],
  ];
  const failed = checks.find(([ok]) => !ok);
  if (failed) return `datum field ${failed[1]} differs from the signed terms`;
  const unit = unitKey(job.unit);
  const paid = unit === "" ? utxo.lovelace - d.collateralReturnLovelace : utxo.tokens[unit] ?? 0n;
  return paid >= job.amount ? null : "underpaid";
}

/** The first UTxO that fully matches the job, if any. Spoofs never shadow it. */
export const findLock = (utxos: EscrowUtxo[], job: ExpectedLock) => utxos.find(u => lockMismatch(u, job) === null);
