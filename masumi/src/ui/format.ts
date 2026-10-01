/** Pure formatting for the inspector: times, amounts, hashes and what kind of value something is. */
import { TUSDM_UNIT, unitKey } from "../constants.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

/** `12 min ago`, `in 1 h 30 min`, `3 days ago`, `just now`. */
export function relative(ms: number, now: number): string {
  const diff = ms - now;
  const abs = Math.abs(diff);
  if (abs < 60_000) return "just now";
  const minutes = Math.round(abs / 60_000);
  const text = minutes < 60 ? `${minutes} min`
    : minutes < 48 * 60 ? `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`
    : `${Math.round(minutes / 1440)} days`;
  return diff > 0 ? `in ${text}` : `${text} ago`;
}

/** POSIX ms as `30 Sep 2026, 10:32:05 UTC (in 18 min)`; 0 means the field is not set. */
export function formatTime(value: number | bigint | string, now: number): string {
  const ms = Number(value);
  if (!ms) return "0 (not set)";
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC (${relative(ms, now)})`;
}

/** `5.00 tADA`, `1.00 tUSDM`, or `7 units` for tokens we don't know the decimals of. */
export function formatAmount(asset: string, amount: string | number | bigint): string {
  const n = Number(amount);
  const unit = unitKey(asset);
  if (unit === "") return `${(n / 1e6).toFixed(2)} tADA`;
  if (unit === TUSDM_UNIT) return `${(n / 1e6).toFixed(2)} tUSDM`;
  return `${amount} units`;
}

/** Keeps the first and last `keep` characters: `ababab…ababab`. */
export const shortMiddle = (text: string, keep = 8) => text.length > keep * 2 + 1 ? `${text.slice(0, keep)}…${text.slice(-keep)}` : text;

export type ValueKind = "time" | "lovelace" | "amount" | "asset" | "tx" | "utxo" | "address" | "hex" | "plain";

/** A readable name for an asset unit (either `policy.name` or `policyname`). */
export function assetLabel(asset: string): string {
  const unit = unitKey(asset);
  if (unit === "") return "tADA (lovelace)";
  if (unit === TUSDM_UNIT) return "Masumi tUSDM";
  return `token ${unit.slice(0, 8)}…`;
}

const numeric = (v: unknown) => typeof v === "number" || typeof v === "bigint" || (typeof v === "string" && /^\d+$/.test(v));

/**
 * What a value is, from its key, its shape, its parent object (an `amount`'s
 * sibling `asset`) and the parent's key (children of `tokens` are amounts keyed by unit).
 */
export function kindOf(key: string, value: unknown, parent?: Record<string, unknown>, parentKey?: string): ValueKind {
  if (numeric(value) && (/Time$/.test(key) || key === "validTo")) return "time";
  if (numeric(value) && parentKey === "tokens") return "amount";
  if (numeric(value) && /lovelace$/i.test(key)) return "lovelace";
  if (numeric(value) && key === "amount" && typeof parent?.asset === "string") return "amount";
  if (typeof value !== "string") return "plain";
  if ((key === "asset" || key === "unit") && (value === "lovelace" || /^[0-9a-f]{56}\.?[0-9a-f]*$/.test(value))) return "asset";
  if (/^[0-9a-f]{64}#\d+$/.test(value)) return "utxo";
  // Only transaction ids get explorer links; result/input hashes and key hashes are plain hex.
  if (/^[0-9a-f]{64}$/.test(value) && /^(txHash|lockTx|resultTx|transaction|claimedTxHash)$/.test(key)) return "tx";
  if (/^addr(_test)?1[0-9a-z]+$/.test(value)) return "address";
  if (/^[0-9a-f]{20,}$/i.test(value)) return "hex";
  return "plain";
}
