/**
 * A job as the agent tracks it, and the JSON view it serves to buyers and the
 * demo UI. Pure: no chain or network access, so it is unit-tested.
 */
import type { EscrowUtxo, ExpectedLock } from "./lockMatch.js";

export type JobInput = { identifier_from_purchaser: string; input_data: { text: string } };
export type Status = "awaiting_payment" | "running" | "completed" | "failed";

/** The escrow lock as the agent found it on chain, without the chain library's objects. */
export type LockSnapshot = Pick<EscrowUtxo, "datum" | "lovelace" | "tokens"> & { ref: string };

export interface Job {
  id: string;
  path: "standard" | "x402";
  status: Status;
  input: JobInput;
  expected: ExpectedLock;
  /** The MIP-003 start_job response returned to the buyer. */
  terms: Record<string, unknown>;
  lockTx?: string;
  lock?: LockSnapshot;
  resultTx?: string;
  result?: string;
  /** MIP-004 sha256(identifier;result), as written into the datum. */
  resultHash?: string;
  /** Set by SubmitResult: slot start of the upper bound + cooldown period (POSIX ms). */
  sellerCooldownTime?: bigint;
  error?: string;
}

export const lockSnapshot = (utxo: EscrowUtxo): LockSnapshot =>
  ({ ref: `${utxo.txHash}#${utxo.outputIndex}`, datum: utxo.datum, lovelace: utxo.lovelace, tokens: utxo.tokens });

/** Deep copy with bigints as strings: JSON cannot carry them. */
const jsonSafe = (value: unknown): unknown =>
  typeof value === "bigint" ? value.toString()
    : Array.isArray(value) ? value.map(jsonSafe)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonSafe(v)]))
    : value;

/** The job as served over HTTP (`/jobs/:id`, `/jobs/by-tx/:hash`, the x402 response). */
export const view = (job: Job) => jsonSafe({
  id: job.id, job_id: job.id, path: job.path, status: job.status, ...job.terms,
  lockTx: job.lockTx, lock: job.lock, resultTx: job.resultTx, result: job.result,
  resultHash: job.resultHash, sellerCooldownTime: job.sellerCooldownTime, error: job.error,
}) as Record<string, unknown>;
