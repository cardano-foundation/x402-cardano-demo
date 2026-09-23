import { ACTORS, type Actor } from "../lib/actors";

export type RailPhase = "idle" | "request" | "required" | "build" | "pay" | "waiting" | "settled";

type NodeState = "idle" | "active" | "done" | "success" | "error";
type ConnectorState = "off" | "flow-right" | "flow-left" | "pulse" | "done" | "done-success" | "error";

interface RailState {
  nodes: Record<Actor, NodeState>;
  connectors: [ConnectorState, ConnectorState, ConnectorState];
}

const IDLE: Record<Actor, NodeState> = { you: "idle", seller: "idle", facilitator: "idle", chain: "idle" };

/** Which connector index "points at" a given actor — used to highlight the
 * edge an in-flight error interrupted. */
const ERROR_CONNECTOR: Partial<Record<Actor, 0 | 1 | 2>> = { seller: 0, facilitator: 1, chain: 2 };

function computeRail(phase: RailPhase, errorActor: Actor | undefined): RailState {
  if (errorActor) {
    const nodes = { ...IDLE, [errorActor]: "error" as NodeState };
    const connectors: RailState["connectors"] = ["off", "off", "off"];
    const edge = ERROR_CONNECTOR[errorActor];
    if (edge !== undefined) connectors[edge] = "error";
    return { nodes, connectors };
  }
  switch (phase) {
    case "request":
      return { nodes: { ...IDLE, you: "active", seller: "active" }, connectors: ["flow-right", "off", "off"] };
    case "required":
      return { nodes: { ...IDLE, you: "active", seller: "active" }, connectors: ["flow-left", "off", "off"] };
    case "build":
      return { nodes: { ...IDLE, you: "active" }, connectors: ["off", "off", "off"] };
    case "pay":
      return {
        nodes: { ...IDLE, you: "active", seller: "active", facilitator: "active" },
        connectors: ["flow-right", "flow-right", "off"],
      };
    case "waiting":
      return {
        nodes: { ...IDLE, you: "done", seller: "done", facilitator: "active", chain: "active" },
        connectors: ["done", "done", "pulse"],
      };
    case "settled":
      return {
        nodes: { ...IDLE, you: "done", seller: "done", facilitator: "success", chain: "success" },
        connectors: ["done", "done", "done-success"],
      };
    default:
      return { nodes: IDLE, connectors: ["off", "off", "off"] };
  }
}

const PHASE_SUMMARY: Record<RailPhase, string> = {
  idle: "Waiting to begin.",
  request: "You are requesting the resource from the seller, unpaid.",
  required: "The seller is naming its price.",
  build: "Your wallet is building and signing the payment transaction.",
  pay: "The seller is asking the facilitator to verify your signed payment.",
  waiting: "The facilitator is waiting for Cardano preprod to reach the requested confirmation depth.",
  settled: "The resource was returned with a settlement receipt.",
};

interface ActorRailProps {
  phase: RailPhase;
  /** Set when the run failed — highlights the actor/edge mid-flight instead of the phase. */
  errorActor?: Actor;
}

export function ActorRail({ phase, errorActor }: ActorRailProps) {
  const { nodes, connectors } = computeRail(phase, errorActor);
  const summary = errorActor
    ? `The flow stopped while waiting on the ${ACTORS.find((a) => a.id === errorActor)?.label}.`
    : PHASE_SUMMARY[phase];

  return (
    <div className="rail" data-phase={errorActor ? "error" : phase}>
      <p className="visually-hidden" aria-live="polite">
        {summary}
      </p>
      <div className="rail__track" aria-hidden="true">
        {ACTORS.map((actor, i) => (
          <RailSegment key={actor.id} isLast={i === ACTORS.length - 1}>
            <div className="rail__node" data-state={nodes[actor.id]}>
              <span className="rail__node-ring" />
              <span className="rail__node-label">{actor.label}</span>
              <span className="rail__node-role">{actor.role}</span>
            </div>
            {i < ACTORS.length - 1 && <RailConnector state={connectors[i as 0 | 1 | 2]} phase={phase} />}
          </RailSegment>
        ))}
      </div>
    </div>
  );
}

function RailSegment({ children, isLast }: { children: React.ReactNode; isLast: boolean }) {
  return <div className="rail__segment" data-last={isLast}>{children}</div>;
}

function RailConnector({ state, phase }: { state: ConnectorState; phase: RailPhase }) {
  return (
    <div className="rail__connector" data-state={state}>
      <span className="rail__connector-line" />
      {(state === "flow-right" || state === "flow-left") && (
        <span key={phase} className="rail__connector-dot" data-dir={state} />
      )}
      {state === "pulse" && <span key={phase} className="rail__connector-pulse" />}
    </div>
  );
}
