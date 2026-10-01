import { useCallback, useEffect, useRef, useState } from "react";
import {
  resumePaymentFlow,
  runPaymentFlow,
  type FlowOutcome,
  type FlowStep,
  type PaymentMethod,
  type PreparedPayment,
} from "../x402/flow";
import { STEP_COPY, STEP_ORDER, type StepId } from "../lib/stepCopy";
import type { Actor } from "../lib/actors";
import type { WalletState } from "../lib/useWallet";
import { ActorRail, type RailPhase } from "../components/ActorRail";
import { Hero } from "../components/Hero";
import { ControlPanel, type RunState } from "../components/ControlPanel";
import type { DemoMethod } from "../components/MethodPicker";
import type { ConfirmationRange } from "../components/SettlementOptions";
import { Timeline, TimelinePreview } from "../components/Timeline";
import { useFollowRun } from "../lib/useFollowRun";

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? "http://localhost:4021";
/**
 * How long the page keeps checking a pending payment on its own. Longer than
 * the transaction's validity (600 s) plus the facilitator's expiry grace, so a
 * payment normally ends confirmed or explicitly expired before this runs out.
 */
const CHECK_WINDOW_MS = 20 * 60_000;

interface DemoConfig {
  l1Confirmations: number;
  facilitator: { l1Confirmations: ConfirmationRange };
  methods: DemoMethod[];
}

interface UncertainPayment {
  payment: PreparedPayment;
  message: string;
  transaction?: string;
}

/**
 * The first tab: an ordinary x402 payment for one HTTP resource, step by step.
 * `onBusyChange` tells the page shell when a payment is in flight, so it does
 * not switch tabs and lose track of it.
 */
export function TransactionsTab({ wallet, onBusyChange }: { wallet: WalletState; onBusyChange: (busy: boolean) => void }) {

  const [config, setConfig] = useState<DemoConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [configError, setConfigError] = useState<string | null>(null);
  const [configSyncing, setConfigSyncing] = useState(false);
  const [configSyncError, setConfigSyncError] = useState<string | null>(null);
  const [method, setMethod] = useState<PaymentMethod | null>(null);

  const [steps, setSteps] = useState<FlowStep[]>([]);
  const [runState, setRunState] = useState<RunState>("idle");
  const [errorMessage, setErrorMessage] = useState<string>();
  const [payStartedAt, setPayStartedAt] = useState<number | null>(null);
  const [uncertain, setUncertain] = useState<UncertainPayment | null>(null);

  const loadConfig = useCallback(async () => {
    setConfigLoading(true);
    setConfigError(null);
    try {
      const response = await fetch(`${SERVER_URL}/demo/config`, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(await responseError(response));
      const next = parseDemoConfig(await response.json());
      setConfig(next);
      setMethod((current) =>
        current && next.methods.some((candidate) => candidate.id === current)
          ? current
          : (next.methods.find((candidate) => candidate.id === "default")?.id ?? next.methods[0].id),
      );
    } catch (error) {
      setConfig(null);
      setMethod(null);
      setConfigError(describeError(error));
    } finally {
      setConfigLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    onBusyChange(runState === "running" || uncertain !== null);
  }, [runState, uncertain, onBusyChange]);

  useEffect(() => {
    if (!uncertain && !(runState === "running" && steps.some(step => step.id === "pay"))) return;
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, [uncertain, runState, steps]);

  async function handleConfirmationsChange(l1Confirmations: number) {
    if (!config || uncertain || runState === "running") return;
    const previous = config;
    setConfigSyncing(true);
    setConfigSyncError(null);
    try {
      const response = await fetch(`${SERVER_URL}/demo/config`, {
        method: "POST",
        signal: AbortSignal.timeout(15_000),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ l1Confirmations }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      setConfig(parseDemoConfig(await response.json()));
      if (runState !== "idle") handleReset();
    } catch (error) {
      setConfig(previous);
      setConfigSyncError(describeError(error));
    } finally {
      setConfigSyncing(false);
    }
  }

  async function handleBegin() {
    const signer = wallet.signer();
    const selected = config?.methods.find((candidate) => candidate.id === method);
    if (!signer || !config || !selected || uncertain) return;
    setSteps([]);
    setErrorMessage(undefined);
    setPayStartedAt(null);
    setRunState("running");
    try {
      const outcome = await runPaymentFlow(SERVER_URL, signer, recordStep, selected.id, {
        l1Confirmations: config.l1Confirmations,
        asset: selected.asset,
        amount: selected.amount,
        automaticChecks: 3,
        checkUntil: Date.now() + CHECK_WINDOW_MS,
      });
      applyOutcome(outcome);
    } catch (error) {
      setErrorMessage(describeError(error));
      setRunState("error");
    }
  }

  async function handleResume() {
    if (!uncertain) return;
    setErrorMessage(undefined);
    setRunState("running");
    setPayStartedAt(Date.now());
    try {
      applyOutcome(await resumePaymentFlow(uncertain.payment, recordStep, { automaticChecks: 3, checkUntil: Date.now() + CHECK_WINDOW_MS }));
    } catch (error) {
      setUncertain((current) =>
        current ? { ...current, message: `Could not check settlement: ${describeError(error)}` } : current,
      );
      setRunState("uncertain");
    }
  }

  function recordStep(step: FlowStep) {
    setSteps((current) => {
      const index = current.findIndex((candidate) => candidate.id === step.id);
      if (index === -1) return [...current, step];
      const next = [...current];
      next[index] = step;
      return next;
    });
    // Automatic checks re-emit "pay"; the waiting clock keeps counting from the first send.
    if (step.id === "pay") setPayStartedAt((current) => current ?? Date.now());
  }

  function applyOutcome(outcome: FlowOutcome) {
    if (outcome.status === "failed") {
      setUncertain(null);
      setErrorMessage(outcome.message);
      setRunState("error");
      return;
    }
    if (outcome.status === "settled") {
      setUncertain(null);
      setRunState("done");
      return;
    }
    setUncertain({
      payment: outcome.payment,
      message: outcome.message,
      transaction: outcome.transaction,
    });
    setRunState("uncertain");
  }

  function handleReset() {
    if (uncertain) return;
    setSteps([]);
    setErrorMessage(undefined);
    setPayStartedAt(null);
    setRunState("idle");
  }

  function handleMethodChange(next: PaymentMethod) {
    if (uncertain || runState === "running") return;
    setMethod(next);
    if (runState !== "idle") handleReset();
  }

  const mainRef = useRef<HTMLDivElement>(null);
  // During a run, keep the newest reached step card in view inside the timeline column.
  useFollowRun(mainRef, ".timeline > li.step-card:not([data-status='pending'])", runState !== "idle", `${steps.length}:${runState}`);

  const selectedMethod = config?.methods.find((candidate) => candidate.id === method);
  const errorStepId: StepId | undefined =
    runState === "error" ? STEP_ORDER.find((id) => !steps.some((step) => step.id === id)) ?? "settled" : undefined;
  const { railPhase, errorActor } = computeRailPhase(steps, runState, errorStepId);

  return (
    <div className="dash dash--two">
      <aside className="dash__col dash__controls" aria-label="Wallet and payment">
        <Hero />

        <ControlPanel
          wallets={wallet.wallets}
          connecting={wallet.connecting}
          connection={wallet.connection}
          connectError={wallet.connectError}
          onSelectWallet={(key) => void wallet.select(key)}
          methods={config?.methods ?? []}
          method={method}
          onMethodChange={handleMethodChange}
          runState={runState}
          onBegin={handleBegin}
          onResume={handleResume}
          onReset={handleReset}
          l1Confirmations={config?.l1Confirmations ?? null}
          confirmationRange={config?.facilitator.l1Confirmations ?? null}
          onConfirmationsChange={handleConfirmationsChange}
          configLoading={configLoading}
          configError={configError}
          onRetryConfig={loadConfig}
          settlementSyncing={configSyncing}
          settlementError={configSyncError}
          uncertainMessage={uncertain?.message}
          uncertainTransaction={uncertain?.transaction}
        />
      </aside>

      <section className="dash__col dash__main dash__main--split" aria-label="Protocol run">
        <ActorRail phase={railPhase} errorActor={errorActor} />
        <div className="dash__scroll" ref={mainRef}>
        {(steps.length > 0 || runState !== "idle") && selectedMethod && (
          <Timeline
            steps={steps}
            method={selectedMethod}
            runState={runState}
            errorStepId={errorStepId}
            errorMessage={errorMessage}
            payStartedAt={payStartedAt}
          />
        )}
        {!(steps.length > 0 || runState !== "idle") && <TimelinePreview />}
        </div>
      </section>
    </div>
  );
}

function computeRailPhase(
  steps: FlowStep[],
  runState: RunState,
  errorStepId: StepId | undefined,
): { railPhase: RailPhase; errorActor?: Actor } {
  if (errorStepId) return { railPhase: "idle", errorActor: STEP_COPY[errorStepId].actor };
  const last = steps[steps.length - 1];
  if (!last) return { railPhase: "idle" };
  if (last.id === "pay" && (runState === "running" || runState === "uncertain")) {
    return { railPhase: "waiting" };
  }
  return { railPhase: last.id };
}

function parseDemoConfig(value: unknown): DemoConfig {
  if (!value || typeof value !== "object") throw new Error("The server returned no payment terms.");
  const config = value as Partial<DemoConfig>;
  const range = config.facilitator?.l1Confirmations;
  if (
    !Number.isInteger(config.l1Confirmations) ||
    !range ||
    !Number.isInteger(range.minimum) ||
    !Number.isInteger(range.maximum) ||
    range.minimum < -1 || range.maximum > 20 || range.minimum > range.maximum ||
    (config.l1Confirmations as number) < range.minimum ||
    (config.l1Confirmations as number) > range.maximum ||
    !Array.isArray(config.methods) ||
    config.methods.length === 0 ||
    config.methods.length > 2
  ) {
    throw new Error("The server returned incomplete payment terms.");
  }
  const ids: PaymentMethod[] = ["default", "usdm"];
  const seen = new Set<PaymentMethod>();
  for (const method of config.methods) {
    if (
      !ids.includes(method.id) ||
      !method.path ||
      !method.label ||
      !method.price ||
      !method.asset ||
      !method.amount
    ) {
      throw new Error("The server returned an invalid payment route.");
    }
    if (seen.has(method.id)) throw new Error("The server returned a duplicate payment route.");
    seen.add(method.id);
  }
  const defaultMethod = config.methods.find((method) => method.id === "default");
  if (!defaultMethod || defaultMethod.asset.toLowerCase() !== "lovelace") {
    throw new Error("The server did not return the default ADA route.");
  }
  return config as DemoConfig;
}

async function responseError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
  return body?.error ?? body?.message ?? `HTTP ${response.status}`;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
