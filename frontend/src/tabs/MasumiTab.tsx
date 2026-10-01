/**
 * The second tab: hire the Masumi agent (masumi/, npm run agent) and follow
 * the money step by step. Pay over x402 with your wallet, hire through
 * Sokosumi with credits, or replay an example that needs neither. The server
 * forwards everything under /masumi to the agent and holds the Sokosumi key.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { formatTusdm } from "../../../masumi/src/constants.js";
import { About } from "../components/About";
import { ColumnResizer } from "../components/ColumnResizer";
import { WalletPicker } from "../components/WalletPicker";
import { useFollowRun } from "../lib/useFollowRun";
import type { WalletState } from "../lib/useWallet";
import { createCip30Signer } from "../masumi/cip30Signer";
import { EXAMPLE_OFFER, exampleDeps } from "../masumi/example";
import { logExchange, recordingApi, stepOf, type HttpLog } from "../masumi/http";
import { Inspector } from "../masumi/Inspector";
import { MoneyRail, STATIONS, type MoneyState } from "../masumi/MoneyRail";
import { createRuns, type RunToken } from "../masumi/runs";
import { runSokosumi, sokosumiSteps } from "../masumi/sokosumiFlow";
import { ACTORS, updateStep, type Step } from "../masumi/steps";
import { ExampleContext } from "../masumi/Value";
import { runX402, x402Steps, type Offer } from "../masumi/x402Flow";
import "../masumi/masumi.css";

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? "http://localhost:4021";
/** Everything the tab asks of the backend lives under /masumi on the demo server. */
const API = `${SERVER_URL}/masumi`;

interface Config { agentIdentifier: string; sellerAddress: string; escrowAddress: string; offers: Offer[]; sokosumi?: { enabled: boolean } }

const VIA_SOKOSUMI = "sokosumi";
const price = (o: Offer) => o.asset === "lovelace" ? `${(Number(o.amount) / 1e6).toFixed(2)} tADA` : formatTusdm(o.amount);
const seconds = (step: Step, now: number) => {
  if (!step.startedAt) return "";
  const s = ((step.endedAt ?? now) - step.startedAt) / 1000;
  return s < 0.1 ? "<0.1 s" : `${s.toFixed(1)} s`;
};
const COUNT = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];
/** The timeline's status vocabulary is the page's (StepCard, status pills). */
const STATUS = { pending: "pending", active: "active", done: "done", failed: "error", skipped: "pending" } as const;
const STATUS_LABEL = { pending: "Waiting", active: "In progress", done: "Done", error: "Failed" } as const;

const ROUTES = {
  registered: "Masumi tUSDM into escrow over x402. Your wallet checks the offer against the agent's on-chain registry entry.",
  unlisted: "The same escrow and job, paid in tADA. This price isn't in the registry, so the wallet checks the seller's signature and the job commitment only.",
  sokosumi: "The standard Masumi path: Sokosumi hires the agent with its own payment node and bills your credits. No wallet needed.",
};

export function MasumiTab({ wallet, onBusyChange }: { wallet: WalletState; onBusyChange: (busy: boolean) => void }) {
  const [config, setConfig] = useState<Config>();
  const [reachable, setReachable] = useState<boolean>();
  const [path, setPath] = useState("/x402/start_job");
  const [text, setText] = useState("hello masumi");
  const [steps, setSteps] = useState<Step[]>([]);
  const [selected, setSelected] = useState<string>();
  const [busy, setBusy] = useState<"real" | "example">();
  const [money, setMoney] = useState<{ state: MoneyState; unlockTime?: number }>({ state: "wallet" });
  /** What the steps on screen describe; fixed when a run starts, so changing the route later can't relabel it. */
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
  const stepsColumn = useRef<HTMLDivElement>(null);
  const dashRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLElement>(null);

  function loadAgent() {
    setReachable(undefined);
    fetch(`${API}/config`).then(r => r.ok ? r.json() : Promise.reject()).then(setConfig).catch(() => setConfig(undefined));
    fetch(`${API}/availability`).then(r => setReachable(r.ok)).catch(() => setReachable(false));
  }
  useEffect(loadAgent, []);
  // Leaving the tab ends a replay; a real run blocks leaving (see onBusyChange).
  useEffect(() => () => runs.stop(), [runs]);
  useEffect(() => { onBusyChange(busy === "real"); }, [busy, onBusyChange]);
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

  /** Back to an idle preview of the chosen route. A failed real run's steps stay, since they point to the funds. */
  function resetIdle() {
    if (realFailure && !example) return;
    runs.stop();
    setSteps([]); setSubject(undefined); setMoney({ state: "wallet" }); setSelected(undefined); setHttp({}); setExample(false);
  }

  /** Starts a run: aborts any other run and resets the page for this one. */
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
      const deps = exampleDeps(900, token.signal);
      const job = await runX402(EXAMPLE_OFFER, "hello masumi", {
        ...deps,
        api: recorded(token, deps.api, "/masumi"),
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
    const api = (p: string, init?: RequestInit) => fetch(`${API}${p}`, init);
    if (viaSokosumi) {
      const token = begin("real", sokosumiSteps(), { via: "sokosumi", amount: "tUSDM" });
      const emit = emitter(token, false);
      let paying = false;
      try {
        await runSokosumi(text, {
          api: recorded(token, api, API),
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
    const walletApi = wallet.api();
    if (!offer || !walletApi) return;
    const token = begin("real", x402Steps(offer), { via: "x402", amount: price(offer) });
    const emit = emitter(token, false);
    let settling = false;
    let lockTx: string | undefined;
    try {
      const job = await runX402(offer, text, {
        api: recorded(token, api, API),
        createSigner: context => createCip30Signer(walletApi, wallet.blockfrost, context),
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

  function choose(id: string) {
    setSelected(id);
    pinned.current = true;
  }

  /** ↑/↓ move through the timeline. */
  function onTimelineKey(event: KeyboardEvent) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const index = Math.min(shown.length - 1, Math.max(0, shown.findIndex(s => s.id === selected) + (event.key === "ArrowDown" ? 1 : -1)));
    const next = shown[index];
    if (!next) return;
    choose(next.id);
    stepList.current?.querySelectorAll<HTMLButtonElement>("button.masumi-step")[index]?.focus();
  }

  const routes = [
    ...(config?.offers ?? []).map(o => ({ id: o.path, label: o.registered ? "Registered price" : "Unlisted tADA price", price: price(o), note: o.registered ? ROUTES.registered : ROUTES.unlisted })),
    ...(config?.sokosumi?.enabled ? [{ id: VIA_SOKOSUMI, label: "Through Sokosumi", price: "credits", note: ROUTES.sokosumi }] : []),
  ];
  const chosen = viaSokosumi ? VIA_SOKOSUMI : offer?.path;
  // Before any run, preview the chosen route's steps as waiting; without an agent, preview the example.
  const shown = steps.length ? steps : viaSokosumi ? sokosumiSteps() : x402Steps(offer ?? EXAMPLE_OFFER);
  const selectedStep = shown.find(s => s.id === selected);
  const activeActor = busy ? steps.find(s => s.status === "active")?.actor : selectedStep?.actor;
  const canRun = busy !== "real" && Boolean(config) && Boolean(text.trim()) && (viaSokosumi || (Boolean(wallet.connection) && Boolean(offer)));
  const via = subject?.via ?? (viaSokosumi ? "sokosumi" : "x402");
  const amount = subject?.amount ?? (viaSokosumi ? "tUSDM" : offer ? price(offer) : price(EXAMPLE_OFFER));
  // During a run, keep the newest reached step in view inside the steps column.
  useFollowRun(stepsColumn, ".masumi-steps > li.step-card:not([data-status='pending'])", steps.length > 0, steps.map(s => s.status).join());

  return (
    <ExampleContext.Provider value={example}>
      <div className="dash dash--three masumi-tab" ref={dashRef}>
        <aside className="dash__col dash__controls" aria-label="Wallet and hire">
          <header className="intro">
            <h1 className="intro__headline">Hire an agent. The money waits in escrow.</h1>
            <p className="intro__note">
              Pay from a buyer wallet, not the seller&rsquo;s. Test tokens: tADA (<a href="https://docs.cardano.org/cardano-testnets/tools/faucet/" target="_blank" rel="noreferrer">faucet ↗</a>)
              and Masumi tUSDM (<a href="https://dispenser.masumi.network/" target="_blank" rel="noreferrer">dispenser ↗</a>,
              policy <span className="mono-tag">16a55b2a…</span>; preprod has a second tUSDM that does not count).
            </p>
            <About>
              <p>
                <strong>Masumi</strong> lists AI agents on Cardano and pays them through an escrow contract. The price is
                locked when the job starts, and the agent can only collect after it has put proof of the result on chain.
                Pay over <strong>x402</strong> with your wallet, or hire through <strong>Sokosumi</strong> with credits.
              </p>
              <ul className="legend">
                {routes.map(route => (
                  <li key={route.id} className="legend__item">
                    <span className="legend__label">{route.label}</span>
                    <span className="legend__blurb">{route.note}</span>
                  </li>
                ))}
              </ul>
              <ul className="legend">
                {[...STATIONS[via], "registry" as const].map(actor => (
                  <li key={actor} className="legend__item">
                    <span className="legend__label">{ACTORS[actor].name}</span>
                    <span className="legend__blurb">{ACTORS[actor].role}</span>
                  </li>
                ))}
              </ul>
            </About>
          </header>

          <section className="control-panel" aria-label="Connect a wallet and hire the agent">
            <div className="control-panel__step">
              <h2 className="section-title"><span className="section-title__n">1</span>Connect a wallet</h2>
              {viaSokosumi ? (
                <p className="control-panel__hint">Not needed for Sokosumi: it pays from its own wallet and bills your credits.</p>
              ) : (
                <WalletPicker
                  wallets={wallet.wallets}
                  connecting={wallet.connecting}
                  connection={wallet.connection}
                  connectError={wallet.connectError}
                  onSelect={key => void wallet.select(key)}
                  disabled={busy === "real"}
                />
              )}
            </div>

            <div className="control-panel__step">
              <h2 className="section-title"><span className="section-title__n">2</span>Hire the agent</h2>

              {reachable === false || (reachable && !config) ? (
                <div className="agent-down" role="status">
                  <p><strong>The agent isn't reachable.</strong> Start it from <span className="mono-tag">masumi/</span> with{" "}
                    <span className="mono-tag">npm run agent</span>, then check again. The example replay below works without it.</p>
                  <button type="button" className="btn btn--ghost" onClick={loadAgent}>Check again</button>
                </div>
              ) : reachable === undefined ? (
                <p className="control-panel__hint" role="status">Looking for the agent…</p>
              ) : (
                <fieldset className="route-picker" disabled={busy === "real"}>
                  <legend>How to pay</legend>
                  {routes.map(route => (
                    <label key={route.id} className="route-picker__option" data-selected={route.id === chosen} title={route.note}>
                      <input type="radio" name="masumi-route" checked={route.id === chosen} aria-describedby={`route-note-${route.id.replace(/\W/g, "")}`}
                        onChange={() => { setPath(route.id); setError(undefined); if (!busy) resetIdle(); }} />
                      <span className="route-picker__label">{route.label}</span>
                      <span className="route-picker__price mono-tag">{route.price}</span>
                    </label>
                  ))}
                  {/* Each route's note, read as the radio's description (the label is its name). */}
                  {routes.map(route => (
                    <span key={route.id} className="visually-hidden" id={`route-note-${route.id.replace(/\W/g, "")}`}>{route.note}</span>
                  ))}
                </fieldset>
              )}

              <label className="job-input">
                <span className="job-input__label">Job input <span className="job-input__hint">reversed and upper-cased by the agent</span></span>
                <textarea value={text} maxLength={500} rows={1} onChange={e => setText(e.target.value)} disabled={busy === "real"} />
              </label>

              <p className="control-panel__hint control-panel__hint--muted">The example runs the real flow against a simulated agent and wallet; no money moves.</p>
              {error && <div className="error-note" role="alert"><p className="error-note__message">{error}</p></div>}

              {/* The actions stay in view at the bottom of the controls column. */}
              <div className="action-bar">
                <div className="masumi-actions">
                  <button type="button" className="btn btn--primary" onClick={run} disabled={!canRun}>
                    {busy === "real" ? "Running…" : viaSokosumi ? "Hire via Sokosumi" : `Pay ${offer ? price(offer) : ""} and run`}
                  </button>
                  <button type="button" className="btn btn--ghost" onClick={replay} disabled={busy === "real"}>
                    {busy === "example" ? "Replaying…" : "Replay an example"}
                  </button>
                </div>
                {!viaSokosumi && config && !wallet.connection && <p className="control-panel__hint control-panel__hint--muted">Connect a preprod wallet first.</p>}
              </div>
            </div>
          </section>

          {config && (
            <dl className="masumi-facts">
              <div><dt>Agent</dt><dd className="mono-tag" title={config.agentIdentifier}>{config.agentIdentifier.slice(0, 14)}…{config.agentIdentifier.slice(-8)}</dd></div>
              <div><dt>Escrow</dt><dd><a className="mono-tag" href={`https://preprod.cardanoscan.io/address/${config.escrowAddress}`} target="_blank" rel="noreferrer">{config.escrowAddress.slice(0, 14)}…{config.escrowAddress.slice(-6)}</a></dd></div>
              <div><dt>Reference</dt><dd className="mono-tag">masumi/docs/FLOWS.md</dd></div>
            </dl>
          )}
        </aside>

        <section className="dash__col dash__main dash__main--split masumi-run" aria-labelledby="masumi-steps-heading">
          <MoneyRail via={via} active={activeActor} money={money.state} unlockTime={money.unlockTime} amount={amount} />
          <div className="masumi-run__intro">
            <h2 id="masumi-steps-heading">
              {COUNT[shown.length] ?? shown.length} steps, {via === "sokosumi" ? "from a Sokosumi hire to escrow" : "from a 402 offer to escrow"}
            </h2>
            {example && <span className="masumi-run__example">example run: simulated, no money moves</span>}
            <p>Select a step to inspect it. <span className="mono-tag">↑ ↓</span> move between steps.</p>
          </div>
          <p className="visually-hidden" aria-live="polite">{announcement}</p>
          {realFailure && (example || !steps.length) && (
            <div className="error-note" role="alert"><p className="error-note__message">Your last real run stopped: {realFailure}</p></div>
          )}
          <div className="dash__scroll" ref={stepsColumn}>
          <ol ref={stepList} className="masumi-steps" onKeyDown={onTimelineKey}>
            {shown.map((step, i) => {
              const status = STATUS[step.status];
              const isSelected = step.id === selected;
              return (
                <li key={step.id} className="step-card" data-status={status} data-selected={isSelected}>
                  <button type="button" className="masumi-step" onClick={() => choose(step.id)} aria-current={isSelected ? "step" : undefined}>
                    <span className="masumi-step__index mono-tag">{String(i + 1).padStart(2, "0")}</span>
                    <span className="masumi-step__title">{step.title}</span>
                    <span className="masumi-step__meta">
                      {ACTORS[step.actor].name}{step.endedAt || busy ? ` · ${seconds(step, now)}` : ""}
                    </span>
                    <span className="status-pill" data-status={status}>
                      <span className="status-pill__dot" aria-hidden="true" />
                      {STATUS_LABEL[status]}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
          </div>
        </section>

        {/* Drag (or arrow keys) to give the inspector more or less room. */}
        <ColumnResizer grid={dashRef} column={detailRef} min={360} reserved={300 + 380 + 6}
          storageKey="masumi-inspector-width" label="Resize the step inspector" />

        <aside className="dash__col dash__detail" ref={detailRef} aria-label="Step inspector">
          <Inspector step={selectedStep} now={now} http={selectedStep ? http[selectedStep.id] : undefined} />
        </aside>
      </div>
    </ExampleContext.Provider>
  );
}
