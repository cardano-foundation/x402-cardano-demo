/**
 * Hiring through Sokosumi, step by step. The UI only sees Sokosumi's job
 * status (through the operator's local proxy); the middle steps happen inside
 * Sokosumi and are explained, not observed.
 */
import { sokosumiStage } from "../sokosumi.js";
import type { Step } from "./steps.js";

export type SokosumiStepId = "hire" | "startJob" | "pay" | "work" | "done" | "collect";
interface ProxyJob { id?: string; status?: string; result?: string | null; name?: string | null; error?: string }

export interface SokosumiDeps {
  /** `fetch` against the local Sokosumi proxy (`/sokosumi/...`). */
  api(path: string, init?: RequestInit): Promise<Response>;
  emit(id: SokosumiStepId, patch: Partial<Step>): void;
  sleep?(ms: number): Promise<void>;
}

const INSIDE = "Happens inside Sokosumi; this UI sees only the job status.";

export const sokosumiSteps = (): Step[] => [
  { id: "hire", actor: "buyer", status: "pending", title: "Create a job on Sokosumi",
    explain: "The UI asks the agent's local proxy, which calls Sokosumi's API (POST /v1/agents/{id}/jobs) with your API key. The key never reaches the browser.",
    lookFor: "The inspector shows the proxy's reduced job (id, status, result, name), not Sokosumi's full response." },
  { id: "startJob", actor: "sokosumi", status: "pending", title: "Sokosumi calls the agent's start_job",
    explain: "Standard Masumi path (MIP-003): the agent returns seller-signed terms (blockchainIdentifier) that Sokosumi's payment node verifies. Run npm run check-purchase to see the same checks locally.",
    lookFor: INSIDE },
  { id: "pay", actor: "sokosumi", status: "pending", title: "Sokosumi's payment node locks tUSDM in escrow",
    explain: "Sokosumi pays from its own wallet into the same Masumi escrow; you are billed in credits. The datum carries the agent's terms and Sokosumi's purchaser id.",
    lookFor: INSIDE },
  { id: "work", actor: "agent", status: "pending", title: "The agent works and submits the result hash",
    explain: "The agent's watcher matches the lock to the signed terms, runs the job and submits sha256(identifier;result) on chain, exactly as on the x402 path.",
    lookFor: "Watch the agent's log: \"completed; SubmitResult <tx>\"." },
  { id: "done", actor: "sokosumi", status: "pending", title: "Sokosumi delivers the result",
    explain: "Sokosumi polls the agent's /status and shows the result.",
    lookFor: "status completed and the result text." },
  { id: "collect", actor: "agent", status: "pending", title: "Seller collects after the unlock time",
    explain: "Agent-driven and outside this purchase: once the result is delivered, the job is complete. After unlock_time (about 60 minutes after start_job on this path: STANDARD_DEADLINES.unlock) the seller runs npm run collect to withdraw the tUSDM; Sokosumi's refundable deposit goes back in the same transaction.",
    lookFor: "Nothing to wait for here; this page does not watch the withdrawal." },
];

/** Which steps a Sokosumi status completes, and which one is running. */
const PROGRESS: Record<string, { done: SokosumiStepId[]; active?: SokosumiStepId }> = {
  paying: { done: ["hire", "startJob"], active: "pay" },
  working: { done: ["hire", "startJob", "pay"], active: "work" },
  // Collecting is the seller's later action, so a completed job checks it too.
  done: { done: ["hire", "startJob", "pay", "work", "done", "collect"] },
};

/** Hires the agent through Sokosumi and follows the job to a terminal status. */
export async function runSokosumi(text: string, deps: SokosumiDeps): Promise<ProxyJob> {
  const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  deps.emit("hire", { status: "active" });
  let created: ProxyJob;
  try {
    const response = await deps.api("/sokosumi/hire", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
    created = await response.json().catch(() => ({ error: `Sokosumi hire failed (HTTP ${response.status}).` }));
    if (!response.ok && created.error) throw new Error(created.error);
  } catch (e) {
    const message = `${e instanceof Error ? e.message : String(e)} The job may still have been created: check your jobs on Sokosumi before hiring again.`;
    deps.emit("hire", { status: "failed", data: { error: message } });
    throw new Error(message);
  }
  if (!created.id) {
    deps.emit("hire", { status: "failed", data: created });
    throw new Error("Sokosumi did not return a job id. Check your jobs on Sokosumi before hiring again.");
  }
  deps.emit("hire", { status: "done", data: { request: { text }, job: created } });

  let failures = 0;
  let activeStep: SokosumiStepId = "startJob";
  for (let current = created; ; ) {
    const stage = sokosumiStage(current.status ?? "");
    if (stage === "stopped") {
      const message = `Sokosumi stopped the job: ${current.status}.`;
      deps.emit(activeStep, { status: "failed", data: { job: current, error: message } });
      throw new Error(message);
    }
    for (const id of PROGRESS[stage].done) {
      const data = id === "done" ? { job: current } : id === "collect" ? { command: "npm run collect", by: "the seller (agent operator), after unlock_time" } : undefined;
      deps.emit(id, { status: "done", ...(data ? { data } : {}) });
    }
    const active = PROGRESS[stage].active;
    if (active) { activeStep = active; deps.emit(active, { status: "active", data: { job: current } }); }
    if (stage === "done") return current;
    await sleep(5000);
    // Reading is safe to retry; the job keeps running (and costing credits) regardless.
    try {
      const poll = await deps.api(`/sokosumi/jobs/${created.id}`);
      const next = await poll.json().catch(() => ({})) as ProxyJob;
      if (!poll.ok || !next.status) throw new Error(next.error ?? `HTTP ${poll.status}`);
      current = next; failures = 0;
    } catch (e) {
      if (++failures >= 6) {
        const message = `Lost track of Sokosumi job ${created.id} (${e instanceof Error ? e.message : e}). It may still complete; check it on Sokosumi.`;
        deps.emit(activeStep, { status: "failed", data: { error: message } });
        throw new Error(message);
      }
    }
  }
}
