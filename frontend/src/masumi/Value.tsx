/** Renders one value by kind: formatted, copyable, linked to the explorer (never in example mode). */
import { createContext, useContext, useState } from "react";
import { assetLabel, formatAmount, formatTime, kindOf, shortMiddle, type ValueKind } from "./format.js";

/** True while showing a replayed example: its hashes are fake, so nothing links to the explorer. */
export const ExampleContext = createContext(false);

const EXPLORER = "https://preprod.cardanoscan.io";

export function Copy({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button type="button" className="copy" aria-label="Copy value" title="Copy"
      onClick={event => { event.stopPropagation(); void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }); }}>
      {copied ? "copied" : "copy"}
    </button>
  );
}

export function Value({ name, value, parent, parentKey, now }: { name: string; value: unknown; parent?: Record<string, unknown>; parentKey?: string; now: number }) {
  const example = useContext(ExampleContext);
  const kind: ValueKind = kindOf(name, value, parent, parentKey);
  const raw = String(value);
  switch (kind) {
    case "time": return <span className="v v-time" title={`${raw} (POSIX ms)`}>{formatTime(raw, now)}</span>;
    case "lovelace": return <span className="v v-amount" title={`${raw} lovelace`}>{formatAmount("lovelace", raw)}</span>;
    case "amount": {
      const asset = parentKey === "tokens" ? name : String(parent?.asset);
      return <span className="v v-amount" title={`${raw} base units of ${asset}`}>{formatAmount(asset, raw)}</span>;
    }
    case "asset": return <span className="v v-hash" title={raw}><span className="v-amount">{assetLabel(raw)}</span>{raw !== "lovelace" && <span className="muted">{shortMiddle(raw, 8)}</span>}<Copy text={raw} /></span>;
    case "tx": case "utxo": case "address": {
      const href = example ? undefined : kind === "address" ? `${EXPLORER}/address/${raw}` : `${EXPLORER}/transaction/${raw.split("#")[0]}`;
      const label = shortMiddle(raw, kind === "address" ? 12 : 10);
      return (
        <span className="v v-hash" title={raw}>
          {href ? <a href={href} target="_blank" rel="noreferrer">{label}</a> : label}
          {example && kind !== "address" && <span className="fake"> example</span>}
          <Copy text={raw} />
        </span>
      );
    }
    case "hex": return <span className="v v-hash" title={raw}>{shortMiddle(raw, 10)}<Copy text={raw} /></span>;
    default:
      if (typeof value === "boolean") return <span className="v v-bool">{raw}</span>;
      if (value === null || value === undefined) return <span className="v v-null">{value === null ? "null" : "—"}</span>;
      return <span className={typeof value === "number" ? "v v-num" : "v v-str"}>{raw}</span>;
  }
}
