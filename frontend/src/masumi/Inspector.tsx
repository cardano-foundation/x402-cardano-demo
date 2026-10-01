/** The selected step in depth: Explain, Datum (grouped, with the deadline axis) and Raw (formatted JSON tree). */
import { useState } from "react";
import type { MasumiDatumView } from "@x402/cardano";
import { Deadlines } from "./Deadlines.js";
import type { HttpLog } from "./http.js";
import { HttpExchangeView } from "./HttpExchange.js";
import { JsonTree } from "./JsonTree.js";
import { ACTORS, datumRows, type Step } from "./steps.js";
import { Value } from "./Value.js";

const isDatum = (value: unknown): value is MasumiDatumView =>
  Boolean(value && typeof value === "object" && "sellerNonce" in value && "state" in value && "buyer" in value);
const findDatum = (data: unknown) => {
  const candidate = data && typeof data === "object" ? (data as { datum?: unknown }).datum : undefined;
  return isDatum(candidate) ? candidate : undefined;
};
/** The agent serves the datum with bigints as strings; turn them back for the table. */
const revive = (d: MasumiDatumView): MasumiDatumView => Object.fromEntries(Object.entries(d).map(([k, v]) =>
  [k, typeof v === "string" && /^\d+$/.test(v) && /Time|Lovelace|state/.test(k) ? BigInt(v) : v])) as unknown as MasumiDatumView;

const GROUPS: Array<{ title: string; fields: number[] }> = [
  { title: "Parties", fields: [0, 1, 2, 3] },
  { title: "Signed terms", fields: [4, 5, 6, 7, 8, 10] },
  { title: "Money and result", fields: [9, 11] },
  { title: "Deadlines", fields: [12, 13, 14, 15] },
  { title: "Contract state", fields: [16, 17, 18] },
];
const FIELD_KEYS = ["buyer", "buyerReturnAddress", "seller", "sellerReturnAddress", "referenceKey", "referenceSignature", "sellerNonce", "buyerNonce",
  "agentIdentifier", "collateralReturnLovelace", "inputHash", "resultHash", "payByTime", "submitResultTime", "unlockTime", "externalDisputeUnlockTime",
  "sellerCooldownTime", "buyerCooldownTime", "state"];

type Tab = "http" | "explain" | "datum" | "raw";

type Credential = { isScript: boolean; hash: string };
/** A datum address as its parts: payment credential and optional stake credential, each copyable. */
function Credentials({ address }: { address: { payment: Credential; stake?: Credential } }) {
  const part = (label: string, c: Credential) => (
    <span className="cred"><span className="cred-label">{label} {c.isScript ? "script" : "key"}</span><Value name="hash" value={c.hash} now={0} /></span>
  );
  return <span className="creds">{part("Payment", address.payment)}{address.stake && part("Stake", address.stake)}</span>;
}

/** The state and empty fields read best as explained text; addresses as credentials; the rest by kind. */
function DatumValue({ field, raw, text, now }: { field: string; raw: unknown; text: string; now: number }) {
  if (raw && typeof raw === "object" && "payment" in raw) return <Credentials address={raw as { payment: Credential; stake?: Credential }} />;
  if (field === "state" || raw === "" || raw === null || typeof raw === "object") return <span className="v v-str">{text}</span>;
  return <Value name={field} value={raw} now={now} />;
}

export function Inspector({ step, now, http }: { step?: Step; now: number; http?: HttpLog }) {
  const datum = step ? findDatum(step.data) : undefined;
  const tabs: Tab[] = [...(http ? ["http" as const] : []), "explain", ...(datum ? ["datum" as const] : []), ...(step?.data !== undefined ? ["raw" as const] : [])];
  const [chosen, setTab] = useState<Tab>("http");
  const tab: Tab = tabs.includes(chosen) ? chosen : tabs[0];

  if (!step) {
    return (
      <aside className="inspector empty" aria-label="Inspector" tabIndex={0}>
        <h2>Inspector</h2>
        <p>Pick a step in the timeline to see who acts, why, and the real data it produced: decoded HTTP headers, signed terms, the escrow datum.</p>
        <p className="muted">No wallet at hand? Use <strong>Replay an example</strong>.</p>
      </aside>
    );
  }
  const view = datum ? revive(datum) : undefined;
  return (
    <aside className="inspector" aria-label="Inspector" tabIndex={0}>
      {step.example && <p className="example-flag">Example run: simulated agent and wallet. No money moves; hashes are fake.</p>}
      <header className="inspector-head">
        <span className={`chip actor-${step.actor}`}>{ACTORS[step.actor].name}</span>
        <h2>{step.title}</h2>
      </header>
      <div className="tabs" role="tablist" aria-label="Views of this step">
        {tabs.map(t => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
            {t === "http" ? `HTTP${http && http.count > 1 ? ` (${http.count})` : ""}` : t === "explain" ? "Explain" : t === "datum" ? "Escrow datum" : "Step data"}
          </button>
        ))}
      </div>
      <div className="tab-body" role="tabpanel">
        {tab === "explain" && (
          <>
            <p className="lede">{step.explain}</p>
            {step.lookFor && <p className="look-for"><strong>What to look for</strong>{step.lookFor}</p>}
            {step.example && step.id === "verify" && <p className="muted">In this example the simulated wallet reports these checks as passed; a real run performs them.</p>}
            {!step.example && step.links?.map(link => <p key={link.href}><a className="ext" href={link.href} target="_blank" rel="noreferrer">{link.label}</a></p>)}
            {step.data === undefined && <p className="muted">{step.status === "pending" ? "Not reached yet." : "No data for this step."}</p>}
          </>
        )}
        {tab === "datum" && view && (
          <>
            <Deadlines datum={view as unknown as Record<string, unknown>} now={now} />
            {GROUPS.map(group => (
              <section key={group.title} className="dgroup">
                <h3>{group.title}</h3>
                <dl>
                  {datumRows(view).filter(r => group.fields.includes(r.index)).map(row => (
                    <div key={row.field} className="drow">
                      <dt><code>{row.index} · {row.field}</code><span className={`by by-${row.decidedBy.split(" ")[0]}`}>{row.decidedBy}</span></dt>
                      <dd>
                        <DatumValue field={FIELD_KEYS[row.index]} raw={(view as unknown as Record<string, unknown>)[FIELD_KEYS[row.index]]} text={row.value} now={now} />
                        <small>{row.meaning}</small>
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </>
        )}
        {tab === "raw" && <JsonTree data={step.data} now={now} />}
        {tab === "http" && http && <HttpExchangeView log={http} now={now} responseFirst={step.id === "settle"} />}
      </div>
    </aside>
  );
}
