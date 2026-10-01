/**
 * Records the HTTP exchanges the flows make, so the UI can show them like a
 * browser's network panel. The flows are unchanged: this wraps their injected
 * `api` function and returns the original response.
 */
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, decodePaymentSignatureHeader } from "@x402/core/http";
import { sokosumiStage } from "../sokosumi.js";

export interface HttpExchange {
  /** Same id for the pending report and the final one of one request. */
  id: number;
  /** True while the request is in flight (no response yet). */
  pending: boolean;
  method: string;
  /** The flow's path (used to place the exchange on a step). */
  path: string;
  /** What the browser really requests (with the dev-server prefix). */
  url: string;
  requestHeaders: Record<string, string>;
  requestBody?: unknown;
  status?: number;
  statusText?: string;
  responseHeaders: Record<string, string>;
  responseBody?: unknown;
  error?: string;
  at: number;
  ms?: number;
}

type Api = (path: string, init?: RequestInit) => Promise<Response>;

/** The response headers worth showing: the body type and x402's own. */
const SHOWN = ["content-type", "payment-required", "payment-response"];

const parse = (text: string): unknown => { try { return JSON.parse(text); } catch { return text || undefined; } };

let nextId = 0;

/** Reports each request twice: when sent (pending) and when answered or failed. */
export function recordingApi(api: Api, onExchange: (exchange: HttpExchange) => void, prefix = ""): Api {
  return async (path, init) => {
    const at = Date.now();
    const id = ++nextId;
    const requestHeaders = Object.fromEntries(new Headers(init?.headers).entries());
    const base = {
      id, method: (init?.method ?? "GET").toUpperCase(), path, url: `${prefix}${path}`, at,
      // Show header names the way the protocol spells them.
      requestHeaders: Object.fromEntries(Object.entries(requestHeaders).map(([k, v]) => [k.toLowerCase().startsWith("payment-") ? k.toUpperCase() : k, v])),
      requestBody: typeof init?.body === "string" ? parse(init.body) : undefined,
    };
    onExchange({ ...base, pending: true, responseHeaders: {} });
    try {
      const response = await api(path, init);
      const responseHeaders = Object.fromEntries(SHOWN.flatMap(name => { const v = response.headers.get(name); return v ? [[name, v]] : []; }));
      const text = await response.clone().text().catch(() => "");
      onExchange({ ...base, pending: false, status: response.status, statusText: response.statusText, responseHeaders, responseBody: parse(text), ms: Date.now() - at });
      return response;
    } catch (error) {
      onExchange({ ...base, pending: false, responseHeaders: {}, error: error instanceof Error ? error.message : String(error), ms: Date.now() - at });
      throw error;
    }
  };
}

const SOKOSUMI_STEP = { paying: "pay", working: "work", done: "done", stopped: "work" } as const;

/** Which timeline step an exchange belongs to: requests by kind, polls by the status they report. */
export function stepOf(exchange: Pick<HttpExchange, "method" | "path" | "requestHeaders"> & { responseBody?: unknown }): string | undefined {
  const paid = Object.keys(exchange.requestHeaders).some(k => k.toLowerCase() === "payment-signature");
  const status = (exchange.responseBody as { status?: unknown } | undefined)?.status;
  if (exchange.method === "POST" && exchange.path.startsWith("/x402/start_job")) return paid ? "pay" : "request";
  if (exchange.path.startsWith("/jobs/by-tx/")) return status === "completed" ? "result" : "lock";
  if (exchange.path === "/sokosumi/hire") return "hire";
  if (exchange.path.startsWith("/sokosumi/jobs/")) return typeof status === "string" ? SOKOSUMI_STEP[sokosumiStage(status)] : "work";
  return undefined;
}

/** What a step keeps of its exchanges: long polls stay light. */
export interface HttpLog { count: number; first: HttpExchange; latest: HttpExchange }

/** Adds (or, for the same id, replaces) an exchange in a step's log. */
export function logExchange(log: HttpLog | undefined, exchange: HttpExchange): HttpLog {
  if (!log) return { count: 1, first: exchange, latest: exchange };
  const replaces = log.latest.id === exchange.id;
  return { count: replaces ? log.count : log.count + 1, first: log.first.id === exchange.id ? exchange : log.first, latest: exchange };
}

const DECODERS: Record<string, (value: string) => unknown> = {
  "payment-required": decodePaymentRequiredHeader,
  "payment-response": decodePaymentResponseHeader,
  "payment-signature": decodePaymentSignatureHeader,
};

/** Decodes the x402 headers present (base64 JSON); anything else is left out. */
export function decodeX402Headers(headers: Record<string, string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(headers).flatMap(([name, value]) => {
    const decode = DECODERS[name.toLowerCase()];
    if (!decode) return [];
    try { return [[name.toLowerCase(), decode(value)]]; } catch { return [[name.toLowerCase(), "(could not decode this header)"]]; }
  }));
}

export const STATUS_TEXT: Record<number, string> = { 200: "OK", 201: "Created", 400: "Bad Request", 402: "Payment Required", 403: "Forbidden", 404: "Not Found", 415: "Unsupported Media Type", 500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable" };
