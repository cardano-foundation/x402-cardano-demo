/** A collapsible, formatted view of any JSON-like data (bigints allowed). */
import { useState } from "react";
import { displayable } from "./steps.js";
import { assetLabel, shortMiddle } from "./format.js";
import { Copy, Value } from "./Value.js";

/** Long keys (token units, hashes) shortened; units under `tokens` named. */
const keyLabel = (name: string, parentKey?: string) =>
  parentKey === "tokens" ? assetLabel(name) : name.length > 28 ? shortMiddle(name, 10) : name;

function Node({ name, value, parent, parentKey, depth, now }: { name: string; value: unknown; parent?: Record<string, unknown>; parentKey?: string; depth: number; now: number }) {
  const container = value !== null && typeof value === "object";
  const [open, setOpen] = useState(depth < 3);
  if (!container) {
    return <li className="jt-leaf"><span className="jt-key" title={name}>{keyLabel(name, parentKey)}</span><Value name={name} value={value} parent={parent} parentKey={parentKey} now={now} /></li>;
  }
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value as Record<string, unknown>);
  return (
    <li className="jt-branch">
      <button type="button" className="jt-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="jt-caret" aria-hidden>{open ? "▾" : "▸"}</span>
        <span className="jt-key">{name}</span>
        <span className="jt-meta">{Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`}</span>
      </button>
      {open && (
        <ul>
          {entries.map(([k, v]) => <Node key={k} name={k} value={v} parent={value as Record<string, unknown>} parentKey={name} depth={depth + 1} now={now} />)}
        </ul>
      )}
    </li>
  );
}

export function JsonTree({ data, now }: { data: unknown; now: number }) {
  const entries = data !== null && typeof data === "object" ? Object.entries(data as Record<string, unknown>) : [["value", data] as const];
  return (
    <div className="jt">
      <div className="jt-bar"><span>Formatted values; hover for the raw value.</span><Copy text={JSON.stringify(displayable(data), null, 2)} /></div>
      <ul className="jt-root">
        {entries.map(([k, v]) => <Node key={k} name={k} value={v} parent={data as Record<string, unknown>} depth={0} now={now} />)}
      </ul>
    </div>
  );
}
