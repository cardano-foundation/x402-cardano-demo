import { test as base, expect } from "@playwright/test";
import { Data } from "@evolution-sdk/evolution";
import { buildMasumiLock, decodeCardanoTransaction, validateMasumiExtra } from "@x402/cardano";
import type { PaymentRequired } from "@x402/core/types";
import type { FlowStep } from "../frontend/src/x402/flow.ts";
import { providerFixture } from "./provider-fixture.ts";

type Backend = Awaited<ReturnType<typeof providerFixture>>;
type BrowserWallet = { [K in keyof Backend["api"] as `fixture_${K}`]: Backend["api"][K] };

const test = base.extend<{ backend: Backend; buyerIsSeller: boolean }>({
  buyerIsSeller: [false, { option: true }],
  backend: async ({ buyerIsSeller }, use) => {
    const cleanups: Array<() => void | Promise<void>> = [];
    try {
      await use(await providerFixture({ after: cleanup => { cleanups.push(cleanup); } }, { buyerIsSeller }));
    } finally {
      for (const cleanup of cleanups.reverse()) await cleanup();
    }
  },
});

for (const buyerIsSeller of [false, true]) test.describe(buyerIsSeller ? "shared wallet" : "separate wallets", () => {
  test.use({ buyerIsSeller });
for (const method of ["masumi", "masumi-usdm"] as const) {
  test(`real browser CIP-30 signer ${buyerIsSeller ? "explains the self-payment rejection before signing" : "settles with the official verifier"}: ${method}`, async ({ page, backend }, testInfo) => {
    // Only the extension API crosses into Node. Transaction construction, datum
    // encoding and the payment flow run in the actual Vite browser modules.
    for (const [name, implementation] of Object.entries(backend.api)) {
      await page.exposeFunction(`fixture_${name}`, implementation);
    }
    await page.route("http://127.0.0.1:44021/demo/config", async route => {
      await route.fulfill({ response: await route.fetch({ url: `${backend.origin}/demo/config` }) });
    });
    await page.goto("/");
    const result = await page.evaluate(async ({ origin, provider, method, signerPath, flowPath }) => {
      const wallet = window as unknown as BrowserWallet;
      const api = {
        getNetworkId: () => wallet.fixture_getNetworkId(),
        getUsedAddresses: () => wallet.fixture_getUsedAddresses(),
        getUnusedAddresses: () => wallet.fixture_getUnusedAddresses(),
        getUtxos: () => wallet.fixture_getUtxos(),
        signTx: (tx: string) => wallet.fixture_signTx(tx),
        submitTx: () => wallet.fixture_submitTx(),
      };
      const { createCip30Signer } = await import(signerPath) as typeof import("../frontend/src/x402/cip30Signer.ts");
      const { runPaymentFlow } = await import(flowPath) as typeof import("../frontend/src/x402/flow.ts");
      const steps: FlowStep[] = [];
      try {
        const signer = await createCip30Signer(api, provider);
        const outcome = await runPaymentFlow(origin, signer, step => steps.push(step), method);
        return { outcome, steps, error: null };
      } catch (error) {
        return { outcome: null, steps, error: error instanceof Error ? error.message : String(error) };
      }
    }, { origin: backend.origin, provider: backend.provider, method, signerPath: "/src/x402/cip30Signer.ts", flowPath: "/src/x402/flow.ts" });

    const diagnostics = JSON.stringify({ ...result, verifications: backend.state.verifications, requests: backend.state.requests }, null, 2);
    await testInfo.attach("browser-verification", { body: diagnostics, contentType: "application/json" });
    if (buyerIsSeller) {
      expect(result.error).toBe("Masumi escrow requires different buyer and seller payout addresses. Connect a different buyer wallet.");
      expect(result.outcome).toBeNull();
      expect(backend.state.signs).toBe(0);
      expect(backend.state.walletSubmits).toBe(0);
      expect(backend.state.submissions).toHaveLength(0);
      expect(backend.state.verifications).toHaveLength(0);
      return;
    }
    expect(result.error, diagnostics).toBeNull();
    expect(result.outcome, diagnostics).toEqual({ status: "settled" });
    expect(backend.state.verifications).toHaveLength(1);
    expect(backend.state.verifications[0].isValid).toBe(true);
    expect(backend.state.signs).toBe(1);
    expect(backend.state.walletSubmits).toBe(0);
    expect(backend.state.submissions).toHaveLength(1);

    const required = result.steps.find(step => step.id === "required")!.detail as PaymentRequired;
    const build = result.steps.find(step => step.id === "build")!;
    if (build.id !== "build") throw new Error("Missing transaction build step");
    const offer = required.accepts[0];
    const transaction = decodeCardanoTransaction(build.detail.transactionBase64);
    const escrow = transaction.outputs.find(output => output.address === offer.payTo)!;
    const schema = validateMasumiExtra(offer.extra, "cardano:preprod");
    if (!schema.ok) throw new Error(schema.detail);
    const expected = buildMasumiLock(schema.extra, backend.payer, offer.asset, BigInt(offer.amount), 4310n);
    expect(escrow.datum).toBe(Data.toCBORHex(expected.datum.data));
    expect(escrow.coin).toBe(expected.lockedLovelace);
    if (method === "masumi-usdm") expect(escrow.assets[offer.asset]).toBe(BigInt(offer.amount));
    expect(backend.state.submissions[0]).toEqual(Buffer.from(build.detail.transactionBase64, "base64"));
  });
}
});
