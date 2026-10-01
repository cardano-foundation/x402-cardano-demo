/**
 * The Masumi tab's backend, mounted under /masumi by app.ts:
 *
 *   /masumi/availability, /masumi/config, /masumi/x402/start_job[/ada],
 *   /masumi/jobs/by-tx/:hash    forwarded to the Masumi agent (masumi/), which
 *                               runs on its own; nothing secret passes here
 *   /masumi/sokosumi/hire, /masumi/sokosumi/jobs/:id
 *                               the operator's Sokosumi proxy: it spends
 *                               credits with SOKOSUMI_API_KEY, so it answers
 *                               only the local demo frontend (see guard below)
 *
 * The agent is the seller; everything here is on the buyer's side.
 */
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { createSokosumi } from "../../masumi/src/sokosumi.js";

type SokosumiClient = ReturnType<typeof createSokosumi>;

export interface MasumiOptions {
  /** Where the Masumi agent listens (masumi/: npm run agent). */
  agentUrl: string;
  /** Origins of the demo frontend, the only callers of the Sokosumi proxy. */
  frontendOrigins?: string[];
  /** Present only when SOKOSUMI_API_KEY is set; without it the proxy is not mounted. */
  sokosumi?: { client: SokosumiClient; maxCredits?: number };
  timeouts?: { getMs?: number; payMs?: number };
}

const DEFAULT_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];
const DEFAULT_AGENT_URL = "http://127.0.0.1:8787";

/** Exact origins only: scheme://host[:port], no path, wildcard or credentials. */
export function parseFrontendOrigins(raw: string | undefined): string[] {
  if (!raw?.trim()) return DEFAULT_ORIGINS;
  return raw.split(",").map(entry => {
    const value = entry.trim();
    let url: URL;
    try { url = new URL(value); } catch { throw new Error(`FRONTEND_ORIGINS: "${value}" is not an origin like http://localhost:5173.`); }
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== value) {
      throw new Error(`FRONTEND_ORIGINS: "${value}" must be exactly scheme://host[:port], like http://localhost:5173.`);
    }
    return value;
  });
}

/** Reads the Masumi settings from the environment; refuses to start on a bad value. */
export function masumiOptionsFromEnv(env: Record<string, string | undefined>): MasumiOptions {
  const agentUrl = env.MASUMI_AGENT_URL?.trim() || DEFAULT_AGENT_URL;
  let parsed: URL | undefined;
  try { parsed = new URL(agentUrl); } catch { /* reported below */ }
  if (!parsed || !["http:", "https:"].includes(parsed.protocol)) throw new Error("MASUMI_AGENT_URL must be an http(s) URL, like http://127.0.0.1:8787.");
  const frontendOrigins = parseFrontendOrigins(env.FRONTEND_ORIGINS);

  const apiKey = env.SOKOSUMI_API_KEY?.trim();
  if (!apiKey) return { agentUrl: agentUrl.replace(/\/+$/, ""), frontendOrigins };
  const agentId = env.SOKOSUMI_AGENT_ID?.trim() || undefined;
  // A common mix-up: the Masumi registry id (policy ++ asset name, 120 hex) is not Sokosumi's id.
  if (agentId && /^[0-9a-f]{120}$/i.test(agentId)) {
    throw new Error("SOKOSUMI_AGENT_ID holds a Masumi registry identifier. Set Sokosumi's own agent id (a UUID such as 01a0f73f-…, from the agent's Sokosumi page or GET /v1/agents), or unset it and use SOKOSUMI_AGENT_NAME.");
  }
  const agentName = env.SOKOSUMI_AGENT_NAME?.trim() || undefined;
  // A catalog lookup by a default name could match someone else's agent and spend these credits on it.
  if (!agentId && !agentName) throw new Error("With SOKOSUMI_API_KEY set, also set SOKOSUMI_AGENT_ID (preferred) or SOKOSUMI_AGENT_NAME (your agent's exact name).");
  const rawCap = env.SOKOSUMI_MAX_CREDITS?.trim();
  const maxCredits = rawCap ? Number(rawCap) : undefined;
  // The only spending cap: a typo must fail loudly, never silently remove it.
  if (maxCredits !== undefined && !(Number.isFinite(maxCredits) && maxCredits > 0)) {
    throw new Error("SOKOSUMI_MAX_CREDITS must be a positive number, or unset for no cap.");
  }
  const client = createSokosumi({
    apiKey,
    baseUrl: (env.SOKOSUMI_API_URL?.trim() || "https://api.preprod.sokosumi.com/v1").replace(/\/+$/, ""),
    agentName: agentName ?? "your Masumi agent",
    agentId,
    organizationSlug: env.SOKOSUMI_ORGANIZATION_SLUG?.trim() || undefined,
  });
  return { agentUrl: agentUrl.replace(/\/+$/, ""), frontendOrigins, sokosumi: { client, maxCredits } };
}

// ---------------------------------------------------------------- Sokosumi proxy

const FORWARDING_HEADERS = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "cf-connecting-ip"];
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Who may spend the operator's credits. The real boundary is the server's
 * 127.0.0.1 bind plus refusing anything relayed by a proxy or tunnel; the
 * Host and Origin checks stop web pages in the operator's browser (DNS
 * rebinding, cross-site requests). Requiring JSON forces a CORS preflight,
 * so a plain HTML form cannot post here either.
 */
export function sokosumiGuard(origins: Set<string>) {
  return (req: Request, res: Response, next: NextFunction) => {
    const port = req.socket.localPort;
    const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    const origin = req.headers.origin;
    const mode = req.headers["sec-fetch-mode"];
    const refuse = !hosts.has((req.headers.host ?? "").toLowerCase())
      || !LOOPBACK.has(req.socket.remoteAddress ?? "")
      || FORWARDING_HEADERS.some(name => name in req.headers)
      || typeof origin !== "string" || !origins.has(origin)
      || (mode !== undefined && mode !== "cors");
    if (refuse) { res.status(403).json({ error: "The Sokosumi proxy only serves the local demo frontend." }); return; }
    if (req.method === "OPTIONS") { next(); return; }
    if (req.method !== "GET" && req.method !== "POST") { res.set("Allow", "GET, POST").status(405).end(); return; }
    if (req.method === "POST" && !req.is("application/json")) { res.status(415).json({ error: "Send application/json." }); return; }
    next();
  };
}

/** Mounted before the app's open CORS, so only `guard` and this router's own CORS decide. */
export function sokosumiRouter(options: Required<Pick<MasumiOptions, "sokosumi">> & { frontendOrigins: string[] }) {
  const { client, maxCredits } = options.sokosumi;
  const origins = new Set(options.frontendOrigins);
  const router = express.Router({ caseSensitive: true, strict: true });
  router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.use(sokosumiGuard(origins));
  router.use(cors({ origin: [...origins], methods: ["GET", "POST"], allowedHeaders: ["Content-Type"] }));
  router.use(express.json({ limit: "4kb" }));
  let hiring = false;
  router.post("/hire", async (req, res) => {
    const text = (req.body as { text?: unknown } | undefined)?.text;
    if (typeof text !== "string" || !text.trim() || text.length > 500) { res.status(400).json({ error: "text must be 1-500 characters" }); return; }
    // One hire at a time: a double click must not become two paid jobs.
    if (hiring) { res.status(409).json({ error: "A hire is already in progress." }); return; }
    hiring = true;
    // Never retried: a second call would be a second paid job.
    try { res.status(201).json(await client.hire(text, maxCredits)); }
    catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : String(error) }); }
    finally { hiring = false; }
  });
  router.get("/jobs/:id", async (req, res) => {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(req.params.id)) { res.status(400).json({ error: "Invalid job id" }); return; }
    try { res.json(await client.job(req.params.id)); }
    catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
  // Body parser errors (malformed JSON 400, too large 413) stay client errors.
  router.use((error: { status?: number; statusCode?: number }, _req: Request, res: Response, _next: NextFunction) => {
    const status = error.status ?? error.statusCode ?? 400;
    res.status(status >= 400 && status < 500 ? status : 400).json({ error: "Bad request" });
  });
  return router;
}

// ---------------------------------------------------------------- agent forward

/** Response headers worth relaying: the body type and x402's own. */
const RELAYED = ["content-type", "payment-required", "payment-response"];

/**
 * Forwards the buyer's calls to the agent on fixed paths only (never the
 * incoming URL), sending just the JSON body and the x402 payment header.
 * Mounted after the app's CORS, which exposes the PAYMENT-* headers.
 */
export function agentRouter(options: MasumiOptions) {
  const getMs = options.timeouts?.getMs ?? 15_000;
  // A paid request returns only after the facilitator has settled.
  const payMs = options.timeouts?.payMs ?? 300_000;
  const router = express.Router({ caseSensitive: true, strict: true });

  async function forward(res: Response, path: string, init: { method?: string; headers?: Record<string, string>; body?: string; paid?: boolean } = {}) {
    let upstream: globalThis.Response;
    try {
      upstream = await fetch(`${options.agentUrl}${path}`, {
        method: init.method ?? "GET", headers: init.headers, body: init.body,
        signal: AbortSignal.timeout(init.paid ? payMs : getMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      if (timedOut) {
        // The payment may already be on chain: say where to look, never retry.
        res.status(504).json({ error: init.paid
          ? "The agent did not answer the paid request in time. The payment may still settle; follow it at /masumi/jobs/by-tx/<lock tx hash>."
          : "The agent did not answer in time." });
      } else {
        res.status(502).json({ error: `The Masumi agent is not reachable at ${options.agentUrl}. Start it with npm run agent in masumi/.` });
      }
      return undefined;
    }
    return upstream;
  }

  async function relay(res: Response, upstream: globalThis.Response) {
    // Read the body first: it can still fail (timeout, reset) after the headers arrived.
    const body = Buffer.from(await upstream.arrayBuffer());
    for (const name of RELAYED) {
      const value = upstream.headers.get(name);
      if (value) res.set(name === "content-type" ? "Content-Type" : name.toUpperCase(), value);
    }
    res.status(upstream.status).send(body);
  }

  /**
   * Express 4 does not catch rejected async handlers, and an unhandled
   * rejection would stop the whole server (the Transactions tab too).
   */
  const safely = (handler: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response) => {
    handler(req, res).catch(error => {
      console.warn(`[masumi] ${req.method} ${req.path}: ${error instanceof Error ? error.message : error}`);
      if (!res.headersSent) res.status(502).json({ error: "The Masumi agent sent an unreadable answer." });
      else res.end();
    });
  };

  router.get("/availability", safely(async (_req, res) => {
    const upstream = await forward(res, "/availability");
    if (upstream) await relay(res, upstream);
  }));

  // The agent's offers, with Sokosumi availability decided by this server (which holds the key).
  router.get("/config", safely(async (_req, res) => {
    const upstream = await forward(res, "/demo/config");
    if (!upstream) return;
    if (!upstream.ok) { await relay(res, upstream); return; }
    // Whatever answers at MASUMI_AGENT_URL may not be the agent: a parse error becomes a 502.
    const config = JSON.parse(await upstream.text()) as Record<string, unknown>;
    res.json({ ...config, sokosumi: { enabled: Boolean(options.sokosumi) } });
  }));

  for (const path of ["/x402/start_job", "/x402/start_job/ada"]) {
    router.post(path, safely(async (req, res) => {
      if (!req.is("application/json")) { res.status(415).json({ error: "Send application/json." }); return; }
      const signature = req.get("PAYMENT-SIGNATURE");
      // Re-serializing is safe: the agent commits to JCS of its own parse of the body.
      const upstream = await forward(res, path, {
        method: "POST", paid: Boolean(signature), body: JSON.stringify(req.body),
        headers: { "Content-Type": "application/json", ...(signature ? { "PAYMENT-SIGNATURE": signature } : {}) },
      });
      if (upstream) await relay(res, upstream);
    }));
  }

  router.get("/jobs/by-tx/:hash", safely(async (req, res) => {
    if (!/^[0-9a-f]{64}$/.test(req.params.hash)) { res.status(400).json({ error: "Invalid transaction hash" }); return; }
    const upstream = await forward(res, `/jobs/by-tx/${req.params.hash}`);
    if (upstream) await relay(res, upstream);
  }));
  return router;
}
