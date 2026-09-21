import type { VerifyResponse } from "@x402/core/types";

/** Application idempotency, separate from the facilitator's broadcast deduplication. */
export class PaymentOperations {
  private readonly payments = new Map<string, { operation: string; retainUntil: number; body?: unknown; verification?: { fingerprint: string; result: VerifyResponse } }>();
  private readonly operations = new Map<string, string>();

  claim(transaction: string, operation: string, validUntil: number): string | undefined {
    const now = Date.now();
    for (const [id, record] of this.payments) {
      if (record.retainUntil < now) {
        this.payments.delete(id);
        this.operations.delete(record.operation);
      }
    }
    const prior = this.payments.get(transaction);
    if (prior) return prior.operation === operation ? undefined : "duplicate_payment_operation";
    if (this.operations.has(operation)) return "duplicate_payment_operation";
    // An old settled transaction must not become a new purchase after eviction.
    if (validUntil <= now) return "payment_expired";
    if (this.payments.size >= 4096) return "payment_operation_capacity";
    // No await between the two claims: one transaction and one operation bind atomically.
    this.payments.set(transaction, { operation, retainUntil: validUntil + 24 * 60 * 60_000 });
    this.operations.set(operation, transaction);
  }

  rememberVerification(transaction: string, fingerprint: string, result: VerifyResponse): void {
    const record = this.payments.get(transaction);
    if (!record || !result.isValid) throw new Error("Only a claimed, verified payment can be remembered");
    record.verification = { fingerprint, result: structuredClone(result) };
  }

  verified(transaction: string, operation: string, fingerprint: string): VerifyResponse | undefined {
    const record = this.payments.get(transaction);
    if (!record || record.retainUntil < Date.now() || record.operation !== operation || record.verification?.fingerprint !== fingerprint) return;
    return structuredClone(record.verification.result);
  }

  result(transaction: string, create: () => unknown): unknown {
    const record = this.payments.get(transaction);
    if (!record) throw new Error("Payment has not been verified for an operation");
    record.body ??= create();
    return record.body;
  }
}
