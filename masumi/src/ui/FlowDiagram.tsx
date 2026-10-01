/**
 * Where the money is: the parties of the chosen path as stations on one line,
 * filled up to the money's current position. It only shows what the flow
 * knows; the state line says how it knows.
 */
import { useEffect, useState } from "react";
import { relative } from "./format.js";
import { ACTORS, type Actor } from "./steps.js";

export type MoneyState = "wallet" | "locked" | "reported" | "collectable" | "unknown";

const STATE_TEXT: Record<MoneyState, { title: string; source: string; detail: string }> = {
  wallet: { title: "In the buyer's wallet", source: "observed", detail: "Nothing has been paid yet. An offer only quotes terms." },
  locked: { title: "Locked in the Masumi escrow", source: "reported by the agent", detail: "The price sits in the vested_pay contract (FundsLocked). Neither side can simply take it." },
  reported: { title: "In escrow, result reported", source: "reported by the agent", detail: "The agent sent SubmitResult (ResultSubmitted, awaiting confirmation). The seller may collect after unlock_time." },
  collectable: { title: "Collectable by the seller", source: "derived from unlock_time", detail: "The unlock time has passed; npm run collect withdraws it. The withdrawal itself is not observed here." },
  unknown: { title: "Unknown: check the explorer", source: "unknown", detail: "The run stopped after the payment was sent. The funds may be in escrow; look up the lock transaction." },
};

export function FlowDiagram({ via, active, money, unlockTime, example, amount }: {
  via: "x402" | "sokosumi"; active?: Actor; money: MoneyState; unlockTime?: number; example?: boolean; amount: string;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!unlockTime) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [unlockTime]);
  const state: MoneyState = money === "reported" && unlockTime && now >= unlockTime ? "collectable" : money;
  const stations: Actor[] = via === "x402" ? ["buyer", "facilitator", "escrow", "agent"] : ["sokosumi", "escrow", "agent"];
  const escrow = stations.indexOf("escrow");
  // The money never reaches the seller here: withdrawal is not observed.
  const at = state === "wallet" ? 0 : state === "unknown" ? escrow - 0.5 : escrow;
  const text = via === "sokosumi" && state === "wallet"
    ? { title: "Not paid yet", source: "inferred from Sokosumi's status", detail: "Sokosumi pays from its own wallet once it has the agent's signed terms." }
    : via === "sokosumi" && state === "unknown"
      ? { ...STATE_TEXT.unknown, detail: "The run stopped after Sokosumi started paying. The funds may be in escrow; check the job on Sokosumi." }
      : STATE_TEXT[state];
  const fill = at / (stations.length - 1); // unitless fraction: portable CSS arithmetic
  return (
    <section className="flow-panel" aria-label="Where the money is">
      <div className="flow-head">
        <h2>Where the money is</h2>
        {example && <span className="example-tag">example run: simulated, no money moves</span>}
      </div>
      <ol className={`pipeline state-${state}`} style={{ ["--n" as string]: stations.length, ["--fill" as string]: fill }}>
        {stations.map((actor, i) => (
          <li key={actor} className={`station actor-${actor} ${i < at ? "passed" : ""} ${i === at ? "here" : ""} ${active === actor ? "acting" : ""}`}
            title={ACTORS[actor].role}>
            <span className="station-dot" aria-hidden />
            {i === at && <span className="amount-tag">{state === "unknown" ? "?" : amount}</span>}
            <strong>{ACTORS[actor].name}</strong>
            <span className="station-role">{actor === "agent" ? "Receives the payment at collect (not observed here)" : ACTORS[actor].role}</span>
          </li>
        ))}
        {state === "unknown" && <li className="station-between" aria-hidden style={{ ["--at" as string]: at }}><span className="amount-tag">?</span></li>}
      </ol>
      <div className={`money-state state-${state}`} aria-live="polite">
        <strong>{text.title}</strong>
        <span className="badge">{via === "sokosumi" ? "inferred from Sokosumi's status" : text.source}</span>
        <span className="money-detail">{text.detail}</span>
      </div>
      {state === "reported" && unlockTime ? <p className="unlock-countdown">Unlocks {relative(unlockTime, now)}.</p> : null}
      {via === "x402" && <p className="registry-note"><span className="chip actor-registry">{ACTORS.registry.name}</span>{ACTORS.registry.role}</p>}
    </section>
  );
}
