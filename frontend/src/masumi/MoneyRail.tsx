/**
 * Where the money is: the parties of the chosen path as nodes on the page's
 * actor rail, with the amount sitting on whoever holds it. It shows only what
 * the flow knows; the line underneath says how it knows.
 */
import { useEffect, useState } from "react";
import { relative } from "./format.js";
import { ACTORS, type Actor } from "./steps.js";

export type MoneyState = "wallet" | "locked" | "reported" | "collectable" | "unknown";

const STATE_TEXT: Record<MoneyState, { title: string; source: string; detail: string }> = {
  wallet: { title: "In the buyer's wallet", source: "observed", detail: "Nothing has been paid yet. An offer only quotes terms." },
  locked: { title: "Locked in the Masumi escrow", source: "reported by the agent", detail: "The price sits in the vested_pay contract (FundsLocked). Neither side can simply take it." },
  reported: { title: "In escrow, result reported", source: "reported by the agent", detail: "The agent sent SubmitResult (ResultSubmitted, awaiting confirmation). The seller may collect after unlock_time." },
  collectable: { title: "Collectable by the seller", source: "derived from unlock_time", detail: "The unlock time has passed; npm run collect in masumi/ withdraws it. The withdrawal itself is not observed here." },
  unknown: { title: "Unknown: check the explorer", source: "unknown", detail: "The run stopped after the payment was sent. The funds may be in escrow; look up the lock transaction." },
};

/** The parties in money order for each way of paying. */
export const STATIONS: Record<"x402" | "sokosumi", Actor[]> = {
  x402: ["buyer", "facilitator", "escrow", "agent"],
  sokosumi: ["sokosumi", "escrow", "agent"],
};

type NodeState = "idle" | "active" | "done" | "success" | "error";

export function MoneyRail({ via, active, money, unlockTime, amount }: {
  via: "x402" | "sokosumi"; active?: Actor; money: MoneyState; unlockTime?: number; amount: string;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!unlockTime) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [unlockTime]);
  const state: MoneyState = money === "reported" && unlockTime && now >= unlockTime ? "collectable" : money;
  const stations = STATIONS[via];
  const escrow = stations.indexOf("escrow");
  // The money never reaches the agent on this page: the withdrawal is not observed.
  const at = state === "wallet" ? 0 : state === "unknown" ? -1 : escrow;
  const text = via === "sokosumi" && state === "wallet"
    ? { title: "Not paid yet", source: "inferred from Sokosumi's status", detail: "Sokosumi pays from its own wallet once it has the agent's signed terms." }
    : via === "sokosumi" && state === "unknown"
      ? { ...STATE_TEXT.unknown, detail: "The run stopped after Sokosumi started paying. The funds may be in escrow; check the job on Sokosumi." }
      : STATE_TEXT[state];
  const nodeState = (i: number): NodeState =>
    state === "unknown" ? (i === escrow ? "error" : "idle")
      : i === at ? (state === "collectable" ? "success" : "active")
      : i < at ? "done" : "idle";

  return (
    <div className="rail money-rail" data-money={state}>
      <div className="rail__track">
        {stations.map((actor, i) => (
          <div key={actor} className="rail__segment" data-last={i === stations.length - 1}>
            {/* "acting" marks who is busy in the selected step; only the money holder is lit. */}
            <div className="rail__node" data-state={nodeState(i)} data-acting={actor === active || undefined}>
              {(i === at || (state === "unknown" && i === escrow)) && (
                <span className="money-rail__amount mono-tag">{state === "unknown" ? "?" : amount}</span>
              )}
              <span className="rail__node-ring" />
              <span className="rail__node-label">{ACTORS[actor].name}</span>
              <span className="rail__node-role">{ROLE[actor]}</span>
            </div>
            {i < stations.length - 1 && (
              <div className="rail__connector" data-state={i < at ? "done" : state === "unknown" && i === escrow - 1 ? "error" : "off"}>
                <span className="rail__connector-line" />
              </div>
            )}
          </div>
        ))}
      </div>
      <p className="money-rail__state" aria-live="polite">
        <strong>{text.title}</strong>
        <span className="mono-tag money-rail__source">{via === "sokosumi" ? "inferred from Sokosumi's status" : text.source}</span>
        <span className="money-rail__detail">{text.detail}</span>
        {state === "reported" && unlockTime ? <span className="money-rail__detail">Unlocks {relative(unlockTime, now)}.</span> : null}
      </p>
    </div>
  );
}

/** Short roles for the rail nodes (the legend carries the long ones). */
const ROLE: Record<Actor, string> = {
  buyer: "Your wallet",
  facilitator: "Verifies + broadcasts",
  escrow: "vested_pay contract",
  agent: "Seller, does the job",
  registry: "On-chain listing",
  sokosumi: "Marketplace, pays for you",
};
