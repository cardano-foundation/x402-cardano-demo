import type { FlowStep } from "../x402/flow";
import { STEP_COPY, STEP_ORDER, type StepId } from "../lib/stepCopy";
import { ACTORS } from "../lib/actors";
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

export function Timeline({ steps, method, runState, errorStepId, errorMessage, payStartedAt }: TimelineProps) {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const requiredStep = byId.get("required");
  const maxTimeoutSeconds = requiredStep
    ? pickCardanoRequirements(asPaymentRequired(requiredStep.detail))?.maxTimeoutSeconds
    : undefined;

  return (
    <section className="timeline-section" aria-label="Protocol steps">
      <TimelineIntro />

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

function TimelineIntro() {
  return (
    <div className="timeline-section__intro">
      <h2>Five visible stages, from 402 to receipt</h2>
      <details className="code-details">
        <summary>Client code</summary>
        <CodeAside />
      </details>
    </div>
  );
}

/** Before the first payment: the five stages, so the column shows what is coming. */
export function TimelinePreview() {
  return (
    <section className="timeline-section" aria-label="Protocol steps">
      <TimelineIntro />
      <ol className="timeline-preview">
        {STEP_ORDER.map((id, i) => (
          <li key={id} className="timeline-preview__item">
            <span className="timeline-preview__index">{String(i + 1).padStart(2, "0")}</span>
            <span className="timeline-preview__label">{STEP_COPY[id].label}</span>
            <span className="timeline-preview__actor">{ACTORS.find((actor) => actor.id === STEP_COPY[id].actor)?.label}</span>
          </li>
        ))}
      </ol>
      <p className="timeline-preview__hint">Connect a wallet and pay to run these steps live.</p>
    </section>
  );
}
