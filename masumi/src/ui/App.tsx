/**
 * An explorable Masumi agent purchase for developers: pick a payment path, run
 * it (or replay an example), and follow the money step by step.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { formatTusdm } from "../constants.js";
import { createCip30Signer } from "./cip30Signer.js";
import { EXAMPLE_OFFER, exampleDeps } from "./example.js";
import { FlowDiagram, type MoneyState } from "./FlowDiagram.js";
import { logExchange, recordingApi, stepOf, type HttpLog } from "./http.js";
import { Inspector } from "./Inspector.js";
import { createRuns, type RunToken } from "./runs.js";
import { runSokosumi, sokosumiSteps } from "./sokosumiFlow.js";
import { ACTORS, updateStep, type Step } from "./steps.js";
import { ExampleContext } from "./Value.js";
import { runX402, x402Steps, type Offer } from "./x402Flow.js";

interface Config { agentIdentifier: string; sellerAddress: string; escrowAddress: string; offers: Offer[]; sokosumi?: { enabled: boolean } }
interface Wallet { name: string; icon: string; enable(): Promise<unknown> }

const blockfrost = {
  baseUrl: import.meta.env.BLOCKFROST_BASE_URL || "https://cardano-preprod.blockfrost.io/api/v0",
  projectId: import.meta.env.BLOCKFROST_PROJECT_ID ?? "",
};
const VIA_SOKOSUMI = "sokosumi";
const price = (o: Offer) => o.asset === "lovelace" ? `${(Number(o.amount) / 1e6).toFixed(2)} tADA` : formatTusdm(o.amount);
const seconds = (step: Step, now: number) => {
  if (!step.startedAt) return "";
  const s = ((step.endedAt ?? now) - step.startedAt) / 1000;
  return s < 0.1 ? "<0.1 s" : `${s.toFixed(1)} s`;
};

const PATHS = {
  registered: "Pay Masumi tUSDM into escrow over x402. The offer is checked against the agent's on-chain registry entry.",
  unlisted: "Same escrow and job, paid in tADA. The price isn't in the registry, so the buyer checks the seller's signature and the job commitment, not the registry.",
  sokosumi: "Standard Masumi path: Sokosumi hires the agent with its own payment node. You pay in credits; no wallet needed.",
};

export function App() {
  const [config, setConfig] = useState<Config>();
  const [reachable, setReachable] = useState<boolean>();
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [wallet, setWallet] = useState<{ name: string; api: unknown }>();
  const [path, setPath] = useState("/x402/start_job");
  const [text, setText] = useState("hello masumi");
  const [steps, setSteps] = useState<Step[]>([]);
  const [selected, setSelected] = useState<string>();
  const [busy, setBusy] = useState<"real" | "example">();
  const [money, setMoney] = useState<{ state: MoneyState; unlockTime?: number }>({ state: "wallet" });
  /** What the steps on screen describe; fixed at the start of a run, so changing the selection later can't relabel it. */
  const [subject, setSubject] = useState<{ via: "x402" | "sokosumi"; amount: string }>();
  const [example, setExample] = useState(false);
  const [error, setError] = useState<string>();
  /** The last real run's failure stays visible (its tx hash matters) even if an example is replayed. */
  const [realFailure, setRealFailure] = useState<string>();
  const [announcement, setAnnouncement] = useState("");
  /** HTTP exchanges per step, for the inspector's HTTP tab. */
  const [http, setHttp] = useState<Record<string, HttpLog>>({});
  const [now, setNow] = useState(Date.now());
  const pinned = useRef(false);
  const runs = useRef(createRuns()).current;
  const stepList = useRef<HTMLOListElement>(null);

  useEffect(() => {
    fetch("/api/demo/config").then(r => r.ok ? r.json() : Promise.reject()).then(setConfig).catch(() => setConfig(undefined));
    fetch("/api/availability").then(r => setReachable(r.ok)).catch(() => setReachable(false));
    setWallets(Object.values((window as { cardano?: Record<string, Wallet> }).cardano ?? {}).filter(w => typeof w?.enable === "function" && w.name));
  }, []);
  // A slow clock for step durations and relative times; faster while something runs.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), busy ? 250 : 5000);
    return () => clearInterval(timer);
  }, [busy]);

  const viaSokosumi = path === VIA_SOKOSUMI && Boolean(config?.sokosumi?.enabled);
  const offer = config?.offers.find(o => o.path === path) ?? config?.offers[0];

  /** Step events of one run; dropped once another run started. */
  const emitter = (run: RunToken, isExample: boolean) => (id: string, patch: Partial<Step>) => run.guard(() => {
    const at = Date.now();
    setSteps(previous => {
      const before = previous.find(s => s.id === id);
      const timing = patch.status === "active" && !before?.startedAt ? { startedAt: at }
        : (patch.status === "done" || patch.status === "failed") && before?.status !== patch.status ? { startedAt: before?.startedAt ?? at, endedAt: at } : {};
      return updateStep(previous, id, { ...patch, ...timing, example: isExample });
    });
    if (patch.status && patch.status !== "pending") {
      setAnnouncement(`Step ${id}: ${patch.status === "active" ? "in progress" : patch.status}`);
      if (!pinned.current) setSelected(id);
    }
  });

  /** Wraps a run's HTTP calls so each exchange shows on its step (dropped once another run started). */
  const recorded = (token: RunToken, api: (path: string, init?: RequestInit) => Promise<Response>, prefix = "") => recordingApi(api, exchange => token.guard(() => {
    // POSTs can take long (the paid one waits for settlement), so show them while pending;
    // polls are quick GETs placed by the status they report, so they show once answered.
    if (exchange.pending && exchange.method === "GET") return;
    const step = stepOf(exchange);
    if (!step) return;
    // The paid request shows on "pay" (what was sent) and on "settle" (what came back after settlement).
    setHttp(all => ({ ...all, [step]: logExchange(all[step], exchange), ...(step === "pay" ? { settle: logExchange(all.settle, exchange) } : {}) }));
  }), prefix);

  /** Back to an idle preview of the chosen path. A failed real run's steps stay, since they point to the funds. */
  function resetIdle() {
    if (realFailure && !example) return;
    runs.stop();
    setSteps([]); setSubject(undefined); setMoney({ state: "wallet" }); setSelected(undefined); setHttp({}); setExample(false);
  }

  /** Starts a run: aborts any other run, resets the page for this one. */
  function begin(kind: "real" | "example", initial: Step[], about: { via: "x402" | "sokosumi"; amount: string }) {
    const token = runs.start(kind);
    pinned.current = false;
    setBusy(kind); setExample(kind === "example"); setError(undefined);
    setSteps(initial.map(s => ({ ...s, example: kind === "example" })));
    setSelected(initial[0]?.id);
    setMoney({ state: "wallet" });
    setSubject(about);
    setHttp({});
    if (kind === "real") setRealFailure(undefined);
    return token;
  }

  async function replay() {
    const token = begin("example", x402Steps(EXAMPLE_OFFER), { via: "x402", amount: price(EXAMPLE_OFFER) });
    const emit = emitter(token, true);
    try {
      const job = await runX402(EXAMPLE_OFFER, "hello masumi", {
        ...(() => { const deps = exampleDeps(900, token.signal); return { ...deps, api: recorded(token, deps.api, "/api") }; })(),
        emit: (id, patch) => {
          emit(id, patch);
          if (patch.status === "done" && id === "lock") token.guard(() => setMoney({ state: "locked" }));
        },
      });
      token.guard(() => setMoney({ state: "reported", unlockTime: job.unlockTime }));
    } catch (e) {
      if (!token.signal.aborted) token.guard(() => setError(e instanceof Error ? e.message : String(e)));
    } finally {
      token.guard(() => setBusy(undefined));
    }
  }

  async function run() {
    if (!config) return;
    if (viaSokosumi) {
      const token = begin("real", sokosumiSteps(), { via: "sokosumi", amount: "tUSDM" });
      const emit = emitter(token, false);
      let paying = false;
      try {
        await runSokosumi(text, {
          api: recorded(token, (p, init) => fetch(p, init)),
          emit: (id, patch) => {
            emit(id, patch);
            if (id === "pay" && patch.status === "active") paying = true;
            if (patch.status === "done" && id === "pay") token.guard(() => setMoney({ state: "locked" }));
            if (patch.status === "done" && id === "work") token.guard(() => setMoney({ state: "reported" }));
          },
        });
      } catch (e) {
        token.guard(() => {
          const message = e instanceof Error ? e.message : String(e);
          setError(message); setRealFailure(message);
          // Sokosumi may already have locked funds once its payment step started.
          if (paying) setMoney(m => m.state === "wallet" ? { state: "unknown" } : m);
        });
      } finally {
        token.guard(() => setBusy(undefined));
      }
      return;
    }
    if (!offer || !wallet) return;
    const token = begin("real", x402Steps(offer), { via: "x402", amount: price(offer) });
    const emit = emitter(token, false);
    let settling = false;
    let lockTx: string | undefined;
    try {
      const job = await runX402(offer, text, {
        api: recorded(token, (p, init) => fetch(`/api${p}`, init), "/api"),
        createSigner: context => createCip30Signer(wallet.api, blockfrost, context),
        emit: (id, patch) => {
          emit(id, patch);
          if (id === "pay" && patch.status === "active") {
            settling = true; // the payment leaves the browser now
            lockTx = (patch.data as { txHash?: string } | undefined)?.txHash;
          }
          if (patch.status === "done" && id === "lock") token.guard(() => setMoney({ state: "locked" }));
        },
      });
      token.guard(() => setMoney({ state: "reported", unlockTime: job.unlockTime }));
    } catch (e) {
      token.guard(() => {
        const message = e instanceof Error ? e.message : String(e);
        setError(message); setRealFailure(lockTx ? `${message} Lock transaction: ${lockTx}` : message);
        // Once the payment was sent, a failure means we cannot say where the money is.
        if (settling) setMoney(m => m.state === "wallet" ? { state: "unknown" } : m);
      });
    } finally {
      token.guard(() => setBusy(undefined));
    }
  }

  async function connect(w: Wallet) {
    setError(undefined);
    try { setWallet({ name: w.name, api: await w.enable() }); }
    catch (e) { setError(`${w.name} did not connect: ${e instanceof Error ? e.message : String(e)}`); }
  }

  /** ↑/↓ move through the timeline. */
  function onTimelineKey(event: KeyboardEvent) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const index = Math.min(shown.length - 1, Math.max(0, shown.findIndex(s => s.id === selected) + (event.key === "ArrowDown" ? 1 : -1)));
    const next = shown[index];
    if (!next) return;
    setSelected(next.id); pinned.current = true;
    stepList.current?.querySelectorAll<HTMLButtonElement>("button")[index]?.focus();
  }

  const choices = [
    ...(config?.offers ?? []).map(o => ({ id: o.path, label: price(o), tag: o.registered ? "x402, registered" : "x402, unlisted", note: o.registered ? PATHS.registered : PATHS.unlisted })),
    ...(config?.sokosumi?.enabled ? [{ id: VIA_SOKOSUMI, label: "Sokosumi credits", tag: "standard path", note: PATHS.sokosumi }] : []),
  ];
  const chosen = viaSokosumi ? VIA_SOKOSUMI : offer?.path;
  // Before any run, preview the chosen path's steps as waiting.
  const shown = steps.length ? steps : viaSokosumi ? sokosumiSteps() : offer ? x402Steps(offer) : [];
  const selectedStep = shown.find(s => s.id === selected);
  const activeActor = busy ? steps.find(s => s.status === "active")?.actor : selectedStep?.actor;
  const needsWallet = !viaSokosumi;
  const canRun = busy !== "real" && Boolean(config) && Boolean(text.trim()) && (!needsWallet || (Boolean(wallet) && Boolean(offer)));
  const via = subject?.via ?? (viaSokosumi ? "sokosumi" : "x402");
  const amount = subject?.amount ?? (viaSokosumi ? "tUSDM" : offer ? price(offer) : "");

  return (
    <ExampleContext.Provider value={example}>
      <header className="topbar">
        <div className="brand">
          <strong>Masumi escrow explorer</strong>
          <span>Follow an AI agent purchase on Cardano: offer, escrow lock, result on chain.</span>
        </div>
        <div className="pills">
          <span className="pill">Cardano preprod</span>
          <span className={`pill ${reachable ? "ok" : reachable === false ? "bad" : ""}`} title="Local /availability of this agent; the registry's Online status needs the public URL">
            <span className="dot" aria-hidden />{reachable === undefined ? "Checking agent" : reachable ? "Agent reachable (local)" : "Agent not reachable"}
          </span>
        </div>
      </header>

      <main className="page">
        <FlowDiagram via={via} active={activeActor} money={money.state} unlockTime={money.unlockTime} example={example}
          amount={amount} />

        {realFailure && (example || !steps.length) && <p className="error persistent" role="alert">Your last real run stopped: {realFailure}</p>}

        <div className="workspace">
          <section className="controls" aria-labelledby="run-heading">
            <h2 id="run-heading">Run a purchase</h2>
            <div className="paths" role="radiogroup" aria-label="Payment path">
              {choices.map(choice => (
                <label key={choice.id} className={`path ${choice.id === chosen ? "chosen" : ""}`}>
                  <input type="radio" name="path" checked={choice.id === chosen} disabled={busy === "real"}
                    onChange={() => { setPath(choice.id); setError(undefined); if (!busy) resetIdle(); }} />
                  <span className="path-head"><strong>{choice.label}</strong><em>{choice.tag}</em></span>
                  <span className="path-note">{choice.note}</span>
                </label>
              ))}
              {!config && <p className="muted small">Start the agent (npm run dev) to run real purchases. The example below works without it.</p>}
            </div>

            {needsWallet && config && (wallet
              ? <p className="wallet-on"><span className="dot" aria-hidden /><span><strong>{wallet.name}</strong> connected. Needs tADA{offer?.asset !== "lovelace" ? " and Masumi tUSDM" : ""}.</span></p>
              : (
                <div className="wallets">
                  {wallets.length === 0 && <p className="muted small">No Cardano wallet found. Install Eternl or Lace and switch it to preprod.</p>}
                  {wallets.map(w => (
                    <button key={w.name} className="ghost" onClick={() => connect(w)}>
                      <img src={w.icon} alt="" width={18} height={18} /> Connect {w.name}
                    </button>
                  ))}
                </div>
              ))}

            <label className="field">
              <span>Job input</span>
              <textarea value={text} maxLength={500} rows={2} onChange={e => setText(e.target.value)} disabled={busy === "real"} />
              <small className="muted">The agent reverses and upper-cases it.</small>
            </label>
            <button className="primary" onClick={run} disabled={!canRun}>
              {busy === "real" ? "Running…" : viaSokosumi ? "Hire via Sokosumi" : `Pay ${offer ? price(offer) : ""} and run`}
            </button>
            <button className="ghost wide" onClick={replay} disabled={busy === "real"}>
              {busy === "example" ? "Replaying example…" : "Replay an example purchase"}
            </button>
            <p className="muted small">The example runs the real flow code against a simulated agent and wallet. No money moves.</p>
            {error && <p className="error" role="alert">{error}</p>}
          </section>

          <section className="timeline" aria-labelledby="steps-heading">
            <h2 id="steps-heading">Steps {example && <span className="example-tag">example</span>}</h2>
            <p className="visually-hidden" aria-live="polite">{announcement}</p>
            {shown.length === 0
              ? <p className="muted">Start the agent or replay the example; the steps appear here. Use ↑ ↓ to move between them.</p>
              : (
                <ol ref={stepList} className="steps" onKeyDown={onTimelineKey}>
                  {shown.map((step, i) => (
                    <li key={step.id} className={`step status-${step.status} ${step.id === selected ? "selected" : ""}`}>
                      <button onClick={() => { setSelected(step.id); pinned.current = true; }} aria-current={step.id === selected ? "step" : undefined}>
                        <span className="step-no">{step.status === "done" ? "✓" : step.status === "failed" ? "!" : i + 1}</span>
                        <span className="step-body">
                          <span className="step-top"><span className={`chip actor-${step.actor}`}>{ACTORS[step.actor].name}</span><span className="step-time">{step.endedAt || busy ? seconds(step, now) : ""}</span></span>
                          <strong>{step.title}</strong>
                          <span className="step-status">{step.status === "done" ? "done" : step.status === "active" ? "in progress" : step.status === "failed" ? "failed" : "waiting"}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ol>
              )}
          </section>

          <Inspector step={selectedStep} now={now} http={selectedStep ? http[selectedStep.id] : undefined} />
        </div>

        {config && (
          <footer className="facts">
            <span>Agent <code title={config.agentIdentifier}>{config.agentIdentifier.slice(0, 14)}…{config.agentIdentifier.slice(-8)}</code></span>
            <span>Escrow {example
              ? <code>{config.escrowAddress.slice(0, 14)}…{config.escrowAddress.slice(-6)}</code>
              : <a href={`https://preprod.cardanoscan.io/address/${config.escrowAddress}`} target="_blank" rel="noreferrer"><code>{config.escrowAddress.slice(0, 14)}…{config.escrowAddress.slice(-6)}</code></a>}</span>
            <span>Protocol details: <code>docs/DEVELOPER.md</code></span>
          </footer>
        )}
      </main>
    </ExampleContext.Provider>
  );
}
