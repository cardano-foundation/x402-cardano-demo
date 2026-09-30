/**
 * Buy one job from the agent over x402: the agent quotes Masumi escrow terms,
 * the wallet signs a lock, the agent settles it, finds it on chain, runs the
 * job and submits the result hash. Sokosumi buyers take the standard path.
 */
import { useEffect, useState } from "react";
import { decodeCardanoTransaction } from "@x402/cardano";
import { ExactCardanoScheme } from "@x402/cardano/exact/client";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { ResourceInfo } from "@x402/core/types";
import { formatTusdm, NETWORK, unitKey } from "../constants.js";

const price = (o: Offer) => o.asset === "lovelace" ? `${(Number(o.amount) / 1e6).toFixed(2)} tADA` : formatTusdm(o.amount);
import { createCip30Signer } from "./cip30Signer.js";

interface Offer { path: string; amount: string; asset: string; resource: string; registered: boolean }
interface Config { agentIdentifier: string; sellerAddress: string; escrowAddress: string; offers: Offer[] }
interface JobView { id: string; status: "awaiting_payment" | "running" | "completed" | "failed"; lockTx?: string; resultTx?: string; result?: string; error?: string; unlockTime?: number }
interface Wallet { name: string; icon: string; enable(): Promise<unknown> }

const blockfrost = {
  baseUrl: import.meta.env.BLOCKFROST_BASE_URL || "https://cardano-preprod.blockfrost.io/api/v0",
  projectId: import.meta.env.BLOCKFROST_PROJECT_ID ?? "",
};
const explorer = (tx: string) => `https://preprod.cardanoscan.io/transaction/${tx}`;
const short = (s: string, n = 10) => s.length > 2 * n ? `${s.slice(0, n)}…${s.slice(-n)}` : s;
const randomHex = (bytes: number) => [...crypto.getRandomValues(new Uint8Array(bytes))].map(b => b.toString(16).padStart(2, "0")).join("");
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type Stage = "idle" | "quoting" | "signing" | "settling" | "locked" | "submitted" | "failed";
const RAIL: Array<{ stage: Stage; title: string; hint: string }> = [
  { stage: "quoting", title: "Quote received", hint: "The agent offers Masumi escrow terms, signed by its seller key." },
  { stage: "signing", title: "Offer verified and signed", hint: "Registry entry, price and URL check out; your wallet signs the lock." },
  { stage: "settling", title: "Lock submitted", hint: "The agent broadcasts your transaction and waits for a confirmation (up to ~2 minutes)." },
  { stage: "locked", title: "Funds in escrow", hint: "The agent found your lock on chain and is running the job." },
  { stage: "submitted", title: "Result submitted", hint: "The result hash is on chain. The seller can collect after the unlock time." },
];
const order = RAIL.map(r => r.stage);

export function App() {
  const [config, setConfig] = useState<Config>();
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [wallet, setWallet] = useState<{ name: string; api: unknown }>();
  const [text, setText] = useState("hello masumi");
  const [offerPath, setOfferPath] = useState("/x402/start_job");
  const offer = config?.offers.find(o => o.path === offerPath) ?? config?.offers[0];
  const [stage, setStage] = useState<Stage>("idle");
  const [job, setJob] = useState<JobView>();
  const [lockTx, setLockTx] = useState<string>();
  const [error, setError] = useState<string>();
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    fetch("/api/demo/config").then(r => r.json()).then(setConfig).catch(() => setError("The agent is not reachable. Start it with npm run dev."));
    const found = Object.values((window as { cardano?: Record<string, Wallet> }).cardano ?? {}).filter(w => typeof w?.enable === "function" && w.name);
    setWallets(found);
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  async function connect(w: Wallet) {
    setError(undefined);
    try { setWallet({ name: w.name, api: await w.enable() }); }
    catch (e) { setError(`${w.name} did not connect: ${e instanceof Error ? e.message : String(e)}`); }
  }

  async function payAndRun() {
    if (!wallet || !config || !offer) return;
    setError(undefined); setJob(undefined); setLockTx(undefined);
    const body = { identifier_from_purchaser: randomHex(10), input_data: { text } };
    try {
      setStage("quoting");
      const init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
      const first = await fetch(`/api${offer.path}`, init);
      if (first.status !== 402) throw new Error(`Expected a payment offer, got HTTP ${first.status}: ${await first.text()}`);
      let resource: ResourceInfo | undefined;
      const signer = await createCip30Signer(wallet.api, blockfrost, () => ({ commitment: body, resource }));
      const http = new x402HTTPClient(x402Client.fromConfig({
        schemes: [{ network: NETWORK, client: new ExactCardanoScheme(signer) }],
        // Neither Masumi tUSDM nor lovelace is one of the library's default
        // assets, so allow exactly the chosen asset, capped at its price.
        spendControls: { allowedAssets: [{ network: NETWORK, asset: offer.asset, maxAmountPerPayment: offer.amount }] },
        // Pay only the advertised price, only in Masumi tUSDM, only into escrow.
        policies: [(_v, offers) => offers.filter(o => o.extra?.assetTransferMethod === "masumi" && unitKey(o.asset) === unitKey(offer.asset) && o.amount === offer.amount)],
      }));
      const required = http.getPaymentRequiredResponse(name => first.headers.get(name));
      resource = required.resource;
      setStage("signing");
      const payload = await http.createPaymentPayload(required);
      const txHash = decodeCardanoTransaction(String(payload.payload.transaction)).txHash;
      setLockTx(txHash);
      setStage("settling");
      // The agent keys the job by this transaction, so we follow it by hash
      // whatever happens to this long request (settlement can take minutes).
      let rejected: string | undefined;
      void fetch(`/api${offer.path}`, { ...init, headers: { ...init.headers, ...http.encodePaymentSignatureHeader(payload) } })
        .then(async r => { if (!r.ok) rejected = `The agent did not accept the payment (HTTP ${r.status}): ${(await r.text()).slice(0, 300) || "no details"}`; })
        .catch(() => { /* a dropped connection says nothing about the payment; keep following the transaction */ });
      const payBy = Number((payload.accepted.extra as { terms?: { payByTime?: string } } | undefined)?.terms?.payByTime ?? Date.now() + 600_000);
      for (;;) {
        await sleep(5000);
        const response = await fetch(`/api/jobs/by-tx/${txHash}`);
        if (!response.ok) {
          if (rejected) throw new Error(rejected);
          if (Date.now() > payBy + 120_000) throw new Error("The agent never recorded this payment. Check the lock transaction on the explorer: if it is not there, it expired and no funds moved; if it is, the agent lost the job (for example after a restart) and the funds wait in escrow for a refund.");
          continue;
        }
        const current = await response.json() as JobView;
        setJob(current);
        if (current.status === "running") setStage("locked");
        if (current.status === "completed") { setStage("submitted"); return; }
        if (current.status === "failed") throw new Error(current.error ?? "The job failed.");
      }
    } catch (e) {
      setStage("failed");
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const reached = (s: Stage) => stage !== "idle" && stage !== "failed" && order.indexOf(s) <= order.indexOf(stage);
  const busy = !["idle", "submitted", "failed"].includes(stage);
  const unlockIn = job?.unlockTime ? Math.max(0, job.unlockTime - now) : undefined;

  return (
    <main className="page">
      <header className="masthead">
        <h1>Hire an agent, pay into escrow</h1>
        <p>This agent is registered on the Masumi network (Cardano preprod). Your payment is locked in Masumi's escrow contract and released to the seller only after the agent has put its result on chain.</p>
      </header>

      <div className="columns">
        <section className="job" aria-labelledby="job-heading">
          <h2 id="job-heading">Your job</h2>
          {!wallet ? (
            <div className="wallets">
              {wallets.length === 0 && <p className="muted">No Cardano wallet found. Install Eternl or Lace and switch it to preprod.</p>}
              {wallets.map(w => (
                <button key={w.name} className="wallet" onClick={() => connect(w)}>
                  <img src={w.icon} alt="" width={20} height={20} /> Connect {w.name}
                </button>
              ))}
            </div>
          ) : <p className="muted">Paying with {wallet.name}. The wallet needs tADA for fees{offer?.asset !== "lovelace" ? " and Masumi tUSDM for the price" : ""}.</p>}

          {config && config.offers.length > 1 && (
            <fieldset className="currency" disabled={busy}>
              <legend>Pay with</legend>
              {config.offers.map(o => (
                <label key={o.path}>
                  <input type="radio" name="offer" checked={o.path === offer?.path} onChange={() => setOfferPath(o.path)} />
                  {price(o)}{o.registered ? " (registered price)" : " (unlisted: not checked against the registry)"}
                </label>
              ))}
            </fieldset>
          )}

          <label className="field">
            <span>Text to transform</span>
            <textarea value={text} maxLength={500} rows={3} onChange={e => setText(e.target.value)} disabled={busy} />
          </label>
          <button className="primary" onClick={payAndRun} disabled={!wallet || !offer || busy || !text.trim()}>
            {busy ? "Working…" : `Pay ${offer ? price(offer) : ""} and run`}
          </button>
          {error && <p className="error" role="alert">{error}</p>}

          <ol className="rail" aria-label="Escrow progress">
            {RAIL.map(step => (
              <li key={step.stage} className={reached(step.stage) ? "reached" : ""} aria-current={stage === step.stage ? "step" : undefined}>
                <strong>{step.title}</strong>
                <span>{step.hint}</span>
                {step.stage === "settling" && lockTx && <a href={explorer(lockTx)} target="_blank" rel="noreferrer" className="hash">{short(lockTx)}</a>}
                {step.stage === "submitted" && job?.resultTx && <a href={explorer(job.resultTx)} target="_blank" rel="noreferrer" className="hash">{short(job.resultTx)}</a>}
              </li>
            ))}
          </ol>

          {job?.result && (
            <div className="result">
              <h3>Result</h3>
              <p className="output">{job.result}</p>
              <p className="muted">
                {unlockIn ? `The seller can collect in ${Math.ceil(unlockIn / 60_000)} min with npm run collect.` : "The seller can collect now with npm run collect."}
              </p>
            </div>
          )}
        </section>

        <aside className="agent" aria-labelledby="agent-heading">
          <h2 id="agent-heading">The agent</h2>
          <p>Reverses and upper-cases your text. A stand-in for real work.</p>
          {config && (
            <dl>
              <dt>Price</dt><dd>{config.offers.map(price).join(" or ")}</dd>
              <dt>Agent id</dt><dd className="hash" title={config.agentIdentifier}>{short(config.agentIdentifier, 14)}</dd>
              <dt>Escrow</dt><dd><a className="hash" href={`https://preprod.cardanoscan.io/address/${config.escrowAddress}`} target="_blank" rel="noreferrer">{short(config.escrowAddress, 12)}</a></dd>
              <dt>Seller</dt><dd className="hash" title={config.sellerAddress}>{short(config.sellerAddress, 12)}</dd>
            </dl>
          )}
          <h3>Hiring through Sokosumi</h3>
          <p>
            The same agent is listed in the <a href="https://preprod.sokosumi.com/agents" target="_blank" rel="noreferrer">Sokosumi preprod catalog</a>.
            Sokosumi hires it with Soko Bot or its API; its payment node pays from Sokosumi's own wallet, so you need no tUSDM there.
          </p>
        </aside>
      </div>
    </main>
  );
}
