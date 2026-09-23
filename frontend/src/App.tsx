import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientCardanoSigner } from "@x402/cardano";
import { createCip30Signer } from "./x402/cip30Signer";
import {
  resumePaymentFlow,
  runPaymentFlow,
  type FlowOutcome,
  type FlowStep,
  type PaymentMethod,
  type PreparedPayment,
} from "./x402/flow";
import { listWallets, type WalletInfo } from "./lib/cip30";
import { STEP_COPY, STEP_ORDER, type StepId } from "./lib/stepCopy";
import type { Actor } from "./lib/actors";
import type { RailPhase } from "./components/ActorRail";
import { Hero } from "./components/Hero";
import { ControlPanel, type RunState } from "./components/ControlPanel";
import type { DemoMethod } from "./components/MethodPicker";
import type { ConfirmationRange } from "./components/SettlementOptions";
import type { WalletConnection } from "./components/WalletPicker";
import { Timeline } from "./components/Timeline";
import { Footer } from "./components/Footer";

const BLOCKFROST_BASE_URL = "https://cardano-preprod.blockfrost.io/api/v0";
const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? "http://localhost:4021";

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

export default function App() {
  const [wallets, setWallets] = useState<WalletInfo[]>(() => listWallets());
  const [connecting, setConnecting] = useState<string | null>(null);
  const [connection, setConnection] = useState<WalletConnection | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const signerRef = useRef<ClientCardanoSigner | null>(null);

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
    const id = window.setTimeout(() => setWallets(listWallets()), 300);
    return () => window.clearTimeout(id);
  }, []);

  useEffect(() => {
    if (!uncertain && !(runState === "running" && steps.some(step => step.id === "pay"))) return;
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, [uncertain, runState, steps]);

  async function handleSelectWallet(key: string) {
    signerRef.current = null;
    setConnection(null);
    setConnecting(key);
    setConnectError(null);
    try {
      const wallet = window.cardano?.[key];
      if (!wallet) throw new Error("That wallet is no longer available. Reload and try again.");
      const api = await wallet.enable();
      const networkId = await api.getNetworkId();
      if (networkId !== 0) {
        throw new Error("This wallet is on Cardano mainnet. Switch it to preprod and connect again.");
      }
      const signer = await createCip30Signer(api, {
        baseUrl: BLOCKFROST_BASE_URL,
        projectId: import.meta.env.VITE_BLOCKFROST_PROJECT_ID,
      });
      signerRef.current = signer;
      setConnection({ key, address: signer.getAddress(), networkId });
    } catch (error) {
      signerRef.current = null;
      setConnection(null);
      setConnectError(describeError(error));
    } finally {
      setConnecting(null);
    }
  }

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
    const signer = signerRef.current;
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
      applyOutcome(await resumePaymentFlow(uncertain.payment, recordStep, { automaticChecks: 3 }));
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
    if (step.id === "pay") setPayStartedAt(Date.now());
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

  const selectedMethod = config?.methods.find((candidate) => candidate.id === method);
  const errorStepId: StepId | undefined =
    runState === "error" ? STEP_ORDER.find((id) => !steps.some((step) => step.id === id)) ?? "settled" : undefined;
  const { railPhase, errorActor } = computeRailPhase(steps, runState, errorStepId);

  return (
    <div className="page">
      <div className="page__atmosphere" aria-hidden="true" />
      <main className="stage">
        <Hero railPhase={railPhase} errorActor={errorActor} />

        <ControlPanel
          wallets={wallets}
          connecting={connecting}
          connection={connection}
          connectError={connectError}
          onSelectWallet={handleSelectWallet}
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
      </main>
      <Footer />
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
    config.methods.length > 4
  ) {
    throw new Error("The server returned incomplete payment terms.");
  }
  const ids: PaymentMethod[] = ["default", "usdm", "masumi", "masumi-usdm"];
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
