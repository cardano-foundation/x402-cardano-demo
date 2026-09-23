import { createHash } from "node:crypto";
import cors from "cors";
import express from "express";
import { x402ResourceServer, x402HTTPResourceServer, type FacilitatorClient, type HTTPTransportContext, type VerifyContext, type RoutesConfig } from "@x402/core/server";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { paymentMiddlewareFromHTTPServer } from "@x402/express";
import { ExactCardanoScheme } from "@x402/cardano/exact/server";
import { decodeCardanoTransaction, masumiEscrowAddress, slotToPosixMs, USDM_PREPROD_ASSET, type MasumiSellerSigner } from "@x402/cardano";
import { PaymentOperations } from "./paymentOperations.js";

export interface ResourceAppOptions {
  facilitator: FacilitatorClient;
  payTo: string;
  masumiSeller: MasumiSellerSigner;
  l1Confirmations?: number;
  usdmAsset?: string;
}

/** Configure the seller without starting a listener or reading credentials. */
export async function createResourceApp(options: ResourceAppOptions) {
  const network = "cardano:preprod";
  const supported = await options.facilitator.getSupported();
  const kind = supported.kinds.find(k => k.x402Version === 2 && k.scheme === "exact" && k.network === network);
  if (!kind) throw new Error("The facilitator must support exact on cardano:preprod.");
  const range = (kind.extra?.l1Confirmations ?? { minimum: 1, maximum: 1 }) as { minimum: number; maximum: number };
  if (!Number.isInteger(range.minimum) || !Number.isInteger(range.maximum) || range.minimum < -1 || range.maximum > 20 || range.minimum > range.maximum) {
    throw new Error("The facilitator returned an invalid confirmation range.");
  }
  const available = kind.extra?.assetTransferMethods ?? ["default"];
  if (!Array.isArray(available) || !available.includes("default")) throw new Error("The facilitator must support ordinary Cardano payments.");
  let l1Confirmations = options.l1Confirmations ?? Math.min(Math.max(1, range.minimum), range.maximum);
  const acceptsLevel = (n: number) => Number.isInteger(n) && n >= range.minimum && n <= range.maximum;
  if (!acceptsLevel(l1Confirmations)) throw new Error(`L1_CONFIRMATIONS must be in the facilitator's range ${range.minimum}..${range.maximum}.`);
  const token = options.usdmAsset || USDM_PREPROD_ASSET;
  const methods = [
    { id: "default", path: "/api/message", label: "ADA payment", price: "2 tADA", asset: "lovelace", amount: "2000000", escrow: false },
    { id: "usdm", path: "/api/message-usdm", label: "Native token", price: "0.10 tUSDM", asset: token, amount: "100000", escrow: false },
    { id: "masumi", path: "/api/message-masumi", label: "Masumi escrow", price: "5 tADA", asset: "lovelace", amount: "5000000", escrow: true },
    { id: "masumi-usdm", path: "/api/message-masumi-usdm", label: "Masumi with token", price: "0.25 tUSDM", asset: token, amount: "250000", escrow: true },
  ].filter(method => !method.escrow || available.includes("masumi"));
  const payments = new PaymentOperations();
  const server = new x402ResourceServer(options.facilitator).register(network,
    new ExactCardanoScheme({ masumi: { seller: options.masumiSeller } }),
  );
  const identity = (context: VerifyContext) => {
    const request = (context.transportContext as HTTPTransportContext).request;
    const url = new URL(request.adapter.getUrl());
    const tx = decodeCardanoTransaction(String(context.paymentPayload.payload.transaction));
    const operation = `${request.method} ${url.pathname}:${url.searchParams.get("requestId") || tx.txHash}`;
    // Bind the cached verification to all original signed bytes and requirements,
    // not merely the transaction hash. Any changed terms must be verified afresh.
    const fingerprint = createHash("sha256").update(JSON.stringify([context.paymentPayload, context.requirements])).digest("hex");
    return { url, tx, operation, fingerprint };
  };
  server.onBeforeVerify(async context => {
    try {
      const { tx, operation, fingerprint } = identity(context);
      const result = payments.verified(tx.txHash, operation, fingerprint);
      // A resumed HTTP request must reach settle(), which owns post-broadcast
      // checks, confirmation polling and expiry. Fresh verification would reject
      // the payment for spending its own inputs or passing its original TTL.
      if (result) return { skip: true as const, result };
    } catch { /* Let the official verifier explain malformed fresh payments. */ }
  });
  server.onAfterVerify(async context => {
    // Core also calls this hook for invalid results. Preserve the verifier's
    // reason and never reserve an operation for an unverified payment.
    if (!context.result.isValid) {
      // Protocol rejections return normally; onVerifyFailure only sees thrown
      // errors. Keep the SDK's explanation available in the seller terminal.
      const { invalidReason, invalidMessage } = context.result;
      console.warn(`[verify] ${invalidReason ?? "invalid_payment"}${invalidMessage ? `: ${invalidMessage}` : ""}`);
      return;
    }
    try {
      const { url, tx, operation, fingerprint } = identity(context);
      // The official quote binds signed terms to a transaction. This application
      // also requires its committed resource to be the request being served.
      if (context.paymentPayload.accepted.extra?.assetTransferMethod === "masumi") {
        const commitment = context.paymentPayload.accepted.extra.inputCommitment as { parts?: Array<{ content?: { url?: string } }> };
        if (commitment?.parts?.length !== 1 || commitment.parts[0].content?.url !== url.href) {
          return { abort: true as const, reason: "payment_resource_mismatch" };
        }
      }
      const reason = payments.claim(tx.txHash, operation, tx.ttlSlot === undefined ? 0 : slotToPosixMs(network, tx.ttlSlot));
      if (reason) return { abort: true as const, reason };
      payments.rememberVerification(tx.txHash, fingerprint, context.result);
    } catch {
      // Core logs and ignores thrown hook errors. Explicitly abort on any failure.
      return { abort: true as const, reason: "invalid_payment_operation" };
    }
  });
  server.onVerifyFailure(async ({ error }) => { console.warn(`[verify] ${error.message}`); });
  server.onSettleFailure(async ({ error }) => { console.warn(`[settle] ${error.message}`); });
  await server.initialize();

  // One immutable route configuration per confirmation level. A paid retry keeps
  // the level in its URL, even if another visitor changes the default controls.
  const middleware = new Map<number, Promise<ReturnType<typeof paymentMiddlewareFromHTTPServer>>>();
  function forLevel(level: number) {
    let handler = middleware.get(level);
    if (!handler) {
      handler = (async () => {
        const routes: RoutesConfig = Object.fromEntries(methods.map(method => [`GET ${method.path}`, {
          accepts: { scheme: "exact", network, payTo: method.escrow ? masumiEscrowAddress(network) : options.payTo,
            price: { amount: method.amount, asset: method.asset }, maxTimeoutSeconds: 600,
            extra: { assetTransferMethod: method.escrow ? "masumi" : "default", areFeesSponsored: false, confirmationPolicy: { l1Confirmations: level } } },
          description: `${method.price} ${method.escrow ? "escrow lock" : "payment"} for a demo message`, mimeType: "application/json",
          settlementFailedResponseBody: (_context: unknown, result: { errorReason?: string }) => ({ contentType: "application/json", body: { error: result.errorReason ?? "settlement_failed" } }),
        }]));
        const http = new x402HTTPResourceServer(server, routes);
        await http.initialize();
        return paymentMiddlewareFromHTTPServer(http, undefined, undefined, false);
      })();
      middleware.set(level, handler);
    }
    return handler;
  }
  await forLevel(l1Confirmations);
  const app = express();
  // The payment gate and resource routes must recognize exactly the same URLs.
  app.enable("case sensitive routing");
  app.enable("strict routing");
  app.use(cors({ origin: true, allowedHeaders: ["Content-Type", "PAYMENT-SIGNATURE"], exposedHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE"] }));
  app.use(express.json({ limit: "16kb" }));
  app.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  const config = () => ({ l1Confirmations, facilitator: { l1Confirmations: range }, methods });
  app.get("/health", (_req, res) => { res.json({ status: "ok", network }); });
  app.get("/demo/config", (_req, res) => { res.json(config()); });
  app.post("/demo/config", (req, res) => {
    if (!req.body || Object.keys(req.body).some(k => k !== "l1Confirmations") || !acceptsLevel(req.body.l1Confirmations)) {
      res.status(400).json({ error: `Choose an integer confirmation level from ${range.minimum} to ${range.maximum}.` }); return;
    }
    l1Confirmations = req.body.l1Confirmations;
    res.json(config());
  });
  app.use((req, res, next) => {
    if (!methods.some(method => method.path === req.path)) return next();
    // Express otherwise invokes GET handlers implicitly for HEAD requests.
    if (req.method !== "GET") { res.set("Allow", "GET").status(405).end(); return; }
    const raw = req.query.confirmations;
    const level = raw === undefined ? l1Confirmations : typeof raw === "string" && /^-?\d+$/.test(raw) ? Number(raw) : NaN;
    const requestId = req.query.requestId;
    if (!acceptsLevel(level) || (requestId !== undefined && (typeof requestId !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(requestId))) || Object.keys(req.query).some(k => k !== "confirmations" && k !== "requestId")) {
      res.status(400).json({ error: "Invalid request ID or unsupported confirmation level." }); return;
    }
    void forLevel(level).then(handler => handler(req, res, next)).catch(next);
  });
  for (const method of methods) {
    app.get(method.path, (req, res, next) => {
      try {
        const payment = decodePaymentSignatureHeader(req.get("PAYMENT-SIGNATURE")!);
        const { txHash } = decodeCardanoTransaction(String(payment.payload.transaction));
        const body = payments.result(txHash, () => ({
          message: method.escrow ? `Hello from x402 on Cardano! ${method.price} was locked in escrow for this message.` : `Hello from x402 on Cardano! This message was paid for with ${method.price}.`,
          paidAt: new Date().toISOString(), operationId: req.query.requestId || txHash,
        }));
        res.json(body);
      } catch (error) { next(error); }
    });
  }
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("[server]", error instanceof Error ? error.message : "Request failed");
    res.status(500).json({ error: "The server could not process this request. Check its log and retry the same payment." });
  });
  return app;
}
