import type { FlowStep } from "../x402/flow";
import { STEP_COPY, STEP_ORDER, type StepId } from "../lib/stepCopy";
import { asPaymentRequired, pickCardanoRequirements } from "../lib/x402Types";
import { StepCard, type StepStatus } from "./StepCard";
import { SettlementWait } from "./SettlementWait";
import { CodeAside } from "./CodeAside";
import type { RunState } from "./ControlPanel";
import type { DemoMethod } from "./MethodPicker";

interface TimelineProps {
  steps: FlowStep[];
  method: DemoMethod;
  runState: RunState;
  errorStepId?: StepId;
  errorMessage?: string;
  payStartedAt: number | null;
}

/** For `masumi`, "confirmed" doesn't mean the same thing it does for
 * `default` — the resource server's own response body already says so (see
 * `/api/message-masumi`'s handler), but the settled step's static copy
 * (`STEP_COPY.settled`) doesn't know which route ran. This fills that one gap
 * without having to fork STEP_COPY per method. */
export function Timeline({ steps, method, runState, errorStepId, errorMessage, payStartedAt }: TimelineProps) {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const requiredStep = byId.get("required");
  const maxTimeoutSeconds = requiredStep
    ? pickCardanoRequirements(asPaymentRequired(requiredStep.detail))?.maxTimeoutSeconds
    : undefined;

  return (
    <section className="timeline-section" aria-label="Protocol steps">
      <div className="timeline-section__intro">
        <h2>Five visible stages, from 402 to receipt</h2>
        <CodeAside />
      </div>

      <ol className="timeline">
        {STEP_ORDER.map((id, i) => {
          const step = byId.get(id);
          const status = stepStatus(id, i, steps.length, runState, errorStepId);
          return (
            <StepCardSlot
              key={id}
              index={i + 1}
              id={id}
              step={step}
              status={status}
              error={status === "error" ? errorMessage : undefined}
              maxTimeoutSeconds={id === "build" ? maxTimeoutSeconds : undefined}
              showWait={id === "pay" && Boolean(step) && !byId.has("settled") && runState === "running"}
              payStartedAt={payStartedAt}
              displayPrice={method.price}
              methodNote={
                id === "settled" && (method.id === "masumi" || method.id === "masumi-usdm")
                  ? `This payment uses Masumi escrow for ${method.price}; it does not pay the seller directly.`
                  : undefined
              }
            />
          );
        })}
      </ol>
    </section>
  );
}

function stepStatus(
  id: StepId,
  index: number,
  reachedCount: number,
  runState: RunState,
  errorStepId?: StepId,
): StepStatus {
  if (index < reachedCount) return "done";
  if (errorStepId === id) return "error";
  if (runState === "running" && index === reachedCount) return "active";
  if (runState === "uncertain" && index === reachedCount) return "paused";
  return "pending";
}

interface StepCardSlotProps {
  index: number;
  id: StepId;
  step?: FlowStep;
  status: StepStatus;
  error?: string;
  maxTimeoutSeconds?: number;
  showWait: boolean;
  payStartedAt: number | null;
  methodNote?: string;
  displayPrice: string;
}

/** A `StepCard` plus, only for `pay`, the settlement-wait interstitial that
 * appears while the facilitator is chasing block inclusion. */
function StepCardSlot({
  index,
  id,
  step,
  status,
  error,
  maxTimeoutSeconds,
  showWait,
  payStartedAt,
  methodNote,
  displayPrice,
}: StepCardSlotProps) {
  return (
    <>
      <StepCard
        index={index}
        id={id}
        copy={STEP_COPY[id]}
        step={step}
        status={status}
        error={error}
        maxTimeoutSeconds={maxTimeoutSeconds}
        methodNote={methodNote}
        displayPrice={displayPrice}
      />
      {showWait && payStartedAt !== null && (
        <li className="timeline__interstitial">
          <SettlementWait startedAt={payStartedAt} />
        </li>
      )}
    </>
  );
}
