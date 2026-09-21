import "dotenv/config";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { toMasumiSellerSigner } from "@x402/cardano";
import { createResourceApp } from "./app.js";

const facilitatorUrl = process.env.FACILITATOR_URL?.trim() || "http://localhost:4022";
const payTo = process.env.SERVER_CARDANO_ADDRESS?.trim();
if (!payTo?.startsWith("addr_test1")) throw new Error("Set SERVER_CARDANO_ADDRESS to your preprod receiving address in server/.env.");
const optionalNumber = (name: string) => process.env[name]?.trim() ? Number(process.env[name]) : undefined;
// npm run dev starts both services together; wait briefly for the facilitator.
let health: { confirmationTimeoutMs?: number } = {};
for (let attempt = 0; attempt < 20; attempt++) {
  try {
    const supported = await fetch(`${facilitatorUrl}/supported`, { signal: AbortSignal.timeout(2000) });
    if (!supported.ok) throw new Error(`HTTP ${supported.status}`);
    break;
  } catch (error) {
    if (attempt === 19) throw new Error(`Cannot reach the Cardano facilitator at ${facilitatorUrl}.`, { cause: error });
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}
try {
  const response = await fetch(`${facilitatorUrl}/health`, { signal: AbortSignal.timeout(2000) });
  if (response.ok) health = await response.json();
} catch { /* An external facilitator need not expose this demo endpoint. */ }
const waitMs = Number.isSafeInteger(health.confirmationTimeoutMs) && health.confirmationTimeoutMs! > 0 ? health.confirmationTimeoutMs! : 75_000;
const timeoutMs = optionalNumber("FACILITATOR_TIMEOUT_MS") ?? Math.max(120_000, waitMs + 45_000);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < waitMs + 15_000) throw new Error("FACILITATOR_TIMEOUT_MS must exceed the facilitator's confirmation wait by at least 15000ms.");
const app = await createResourceApp({
  facilitator: new HTTPFacilitatorClient({ url: facilitatorUrl, timeoutMs }), payTo,
  masumiSeller: toMasumiSellerSigner({ network: "cardano:preprod", mnemonic: process.env.MASUMI_SELLER_MNEMONIC?.trim() || "test test test test test test test test test test test junk" }),
  l1Confirmations: optionalNumber("L1_CONFIRMATIONS"), usdmAsset: process.env.USDM_ASSET?.trim(),
});
app.listen(Number(process.env.PORT || 4021), "127.0.0.1", () => console.log(`Resource server: http://localhost:${process.env.PORT || 4021}`));
