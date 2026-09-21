/** HTTP wrapper around the published Cardano facilitator. It never holds keys. */
import "dotenv/config";
import express from "express";
import { x402Facilitator } from "@x402/core/facilitator";
import { toFacilitatorCardanoSigner } from "@x402/cardano";
import { ExactCardanoScheme } from "@x402/cardano/exact/facilitator";
import { confirmExpiry } from "./settlement.js";

const network = "cardano:preprod";
const projectId = process.env.BLOCKFROST_PROJECT_ID?.trim();
if (!projectId) throw new Error("Set BLOCKFROST_PROJECT_ID in facilitator/.env to a preprod project ID.");
const confirmationTimeoutMs = Number(process.env.CONFIRMATION_TIMEOUT_MS ?? 75_000);
if (!Number.isInteger(confirmationTimeoutMs) || confirmationTimeoutMs < 1_000 || confirmationTimeoutMs > 600_000) {
  throw new Error("CONFIRMATION_TIMEOUT_MS must be an integer from 1000 to 600000.");
}
const acceptMempool = process.env.ACCEPT_MEMPOOL === "true";
const signer = toFacilitatorCardanoSigner({
  network,
  provider: { blockfrost: {
    baseUrl: process.env.BLOCKFROST_BASE_URL || "https://cardano-preprod.blockfrost.io/api/v0",
    projectId,
  } },
  // Return after broadcast; the scheme handles its own bounded confirmation wait.
  awaitConfirmation: false,
});
const facilitator = new x402Facilitator().register(network,
  new ExactCardanoScheme(signer, { acceptMempool, confirmationTimeoutMs }),
);
const app = express();
app.use(express.json({ limit: "1mb" }));
for (const action of ["verify", "settle"] as const) {
  app.post(`/${action}`, async (req, res) => {
    const { paymentPayload, paymentRequirements } = req.body ?? {};
    if (!paymentPayload || !paymentRequirements) {
      res.status(400).json({ error: "Missing paymentPayload or paymentRequirements" }); return;
    }
    try {
      // Invalid payments are protocol responses (HTTP 200), not transport errors.
      res.json(action === "settle"
        ? await confirmExpiry(await facilitator.settle(paymentPayload, paymentRequirements), signer)
        : await facilitator.verify(paymentPayload, paymentRequirements));
    } catch (error) {
      console.error(`[${action}]`, error instanceof Error ? error.message : "Request failed");
      res.status(500).json({ error: "Facilitator request failed; see its log." });
    }
  });
}
app.get("/supported", (_req, res) => { res.json(facilitator.getSupported()); });
app.get("/health", (_req, res) => {
  res.json({ status: "ok", network, confirmationTimeoutMs, acceptMempool });
});
const port = Number(process.env.PORT ?? 4022);
app.listen(port, "127.0.0.1", () => {
  console.log(`Cardano facilitator: http://localhost:${port} (${network}, wait ${confirmationTimeoutMs}ms)`);
});
