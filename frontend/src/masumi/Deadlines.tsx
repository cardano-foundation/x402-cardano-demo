/** The escrow's four deadlines on one axis, with where "now" is and what that means. */
import { formatTime, relative } from "./format.js";

const MARKS = [
  { key: "payByTime", label: "Pay by", meaning: "the lock must land before this" },
  { key: "submitResultTime", label: "Submit result", meaning: "the agent must put the result hash on chain before this" },
  { key: "unlockTime", label: "Unlock", meaning: "the seller may withdraw from here" },
  { key: "externalDisputeUnlockTime", label: "Dispute ends", meaning: "the dispute window closes" },
] as const;

export function Deadlines({ datum, now }: { datum: Record<string, unknown>; now: number }) {
  const times = MARKS.map(m => ({ ...m, at: Number(datum[m.key]) }));
  if (times.some(t => !t.at)) return null;
  const start = Math.min(now, times[0].at) - 60_000;
  const end = times[3].at;
  const pos = (ms: number) => `${Math.max(0, Math.min(100, ((ms - start) / (end - start)) * 100))}%`;
  const next = times.find(t => t.at > now);
  return (
    <figure className="deadlines">
      <div className="axis" role="img" aria-label={`Deadlines; next: ${next ? `${next.label} ${relative(next.at, now)}` : "all passed"}`}>
        {times.map(t => <span key={t.key} className={`mark ${t.at <= now ? "passed" : ""}`} style={{ left: pos(t.at) }} />)}
        <span className="now" style={{ left: pos(now) }}><span>now</span></span>
      </div>
      <ol className="axis-legend">
        {times.map(t => (
          <li key={t.key} className={t.at <= now ? "passed" : ""}>
            <strong>{t.label}</strong> <span title={formatTime(t.at, now)}>{relative(t.at, now)}</span>
            <small>{t.meaning}</small>
          </li>
        ))}
      </ol>
    </figure>
  );
}
