import { useElapsedSeconds } from "../lib/hooks";
import { formatElapsed } from "../lib/format";

interface SettlementWaitProps {
  startedAt: number;
}

/**
 * The facilitator owns submission and waits for the configured on-chain
 * evidence. The clock reassures visitors during a real network operation
 * without promising a Cardano block schedule.
 */
export function SettlementWait({ startedAt }: SettlementWaitProps) {
  const elapsed = useElapsedSeconds(startedAt, true);

  // The visual clock ticks every 250ms (see useElapsedSeconds) — fine to look
  // at, unbearable to have re-announced by a screen reader. This separate
  // hidden live region announces once at the start, then only when the
  // 10-second bucket changes, so it stays sparse for however long settlement takes.
  const announcement =
    elapsed < 10
      ? "Waiting for on-chain confirmation…"
      : `Still waiting, about ${Math.floor(elapsed / 10) * 10} seconds.`;

  return (
    <div className="settlement-wait">
      <p className="visually-hidden" aria-live="polite">
        {announcement}
      </p>
      <div className="settlement-wait__pulse" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className="settlement-wait__copy">
        <p className="settlement-wait__title">Waiting for Cardano settlement…</p>
        <p className="settlement-wait__detail">
          The facilitator checks the requested confirmation depth. Pending payments and interrupted responses
          get up to three automatic checks using the same signature. Keep this page open; each check can take a few minutes.
        </p>
      </div>
      <div className="settlement-wait__clock mono-tag">{formatElapsed(elapsed)}</div>
    </div>
  );
}
