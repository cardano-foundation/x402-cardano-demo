import { test as base, expect, type Page } from "@playwright/test";
import { x402Facilitator } from "@x402/core/facilitator";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import type { SupportedResponse } from "@x402/core/types";
import { ExactCardanoScheme } from "@x402/cardano/exact/facilitator";
import { createResourceApp } from "../server/src/app.ts";
import { createFixture, seller } from "./fixtures.ts";

type Backend = Awaited<ReturnType<typeof createFixture>> & { paymentHeaders: string[] };

// Exercise the real browser flow and official server/facilitator packages. Only
// the extension boundary and chain provider are replaced with offline fixtures.
const test = base.extend<{ backend: Backend }>({
  backend: async ({}, use) => {
    const fixture = await createFixture();
    const facilitator = new x402Facilitator().register("cardano:preprod", new ExactCardanoScheme(fixture.chain, {
      confirmationTimeoutMs: 10, confirmationPollMs: 1, acceptMempool: true,
    }));
    const app = await createResourceApp({
      facilitator: {
        getSupported: async () => facilitator.getSupported() as SupportedResponse,
        verify: (payload, requirements) => facilitator.verify(payload, requirements),
        settle: (payload, requirements) => facilitator.settle(payload, requirements),
      },
      payTo: seller.sellerAddress,
      masumiSeller: seller,
    });
    const listener = app.listen(44021, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      listener.once("listening", resolve);
      listener.once("error", reject);
    });
    try { await use({ ...fixture, paymentHeaders: [] }); }
    finally {
      listener.closeAllConnections();
      await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    }
  },
});

async function openDemo(page: Page, backend: Backend, walletMode: "testnet" | "mainnet" | "reject" = "testnet") {
  await page.exposeFunction("fixtureSign", backend.client.buildAndSignPaymentTransaction);
  await page.addInitScript(({ mode }) => {
    const state = window as unknown as { fixtureWalletMode: string; cardano: unknown };
    state.fixtureWalletMode = mode;
    state.cardano = {
      fixture: {
        name: "Fixture wallet",
        enable: async () => {
          if (state.fixtureWalletMode === "reject") throw new Error("Wallet connection rejected by user");
          return { getNetworkId: async () => state.fixtureWalletMode === "mainnet" ? 1 : 0 };
        },
      },
    };
  }, { mode: walletMode });
  await page.route("**/src/x402/cip30Signer.ts*", route => route.fulfill({
    contentType: "application/javascript",
    body: `export async function createCip30Signer() { return {
      getAddress: () => ${JSON.stringify(backend.payer)},
      buildAndSignPaymentTransaction: input => window.fixtureSign(input)
    }; }`,
  }));
  page.on("request", request => {
    const header = request.headers()["payment-signature"];
    if (header) backend.paymentHeaders.push(header);
  });
  await page.goto("/");
}

async function connect(page: Page) {
  await page.getByRole("button", { name: "Fixture wallet Connect" }).click();
  await expect(page.getByText("Testnet wallet", { exact: true })).toBeVisible();
}

async function expectLockedPayment(page: Page) {
  await expect(page.getByRole("button", { name: "Start a new payment" })).toHaveCount(0);
  await page.getByText("Advanced", { exact: true }).click();
  await expect(page.getByRole("radio").first()).toBeDisabled();
  await expect(page.getByLabel("Confirmations before unlock")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Reconnect wallet" })).toBeDisabled();
}

test("unavailable configuration blocks payment until Retry succeeds", async ({ page, backend }) => {
  let unavailable = true;
  await page.route("**/demo/config", route => unavailable
    ? route.fulfill({ status: 503, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ error: "Fixture server is starting" }) })
    : route.continue());
  await openDemo(page, backend);
  await connect(page);
  await expect(page.getByRole("alert")).toContainText("Payment terms are unavailable");
  await expect(page.getByRole("button", { name: "Pay 2 tADA" })).toHaveCount(0);
  unavailable = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pay 2 tADA" })).toBeEnabled();
  expect(backend.state.builds).toBe(0);
});

test("ADA is the default with Advanced collapsed on desktop and mobile", async ({ page, backend }) => {
  await openDemo(page, backend);
  await expect(page.getByRole("button", { name: "Pay 2 tADA" })).toBeDisabled();
  await expect(page.locator("details.advanced-options")).not.toHaveAttribute("open");
  await expect(page.locator('input[type="radio"]')).toHaveCount(4);
  await expect(page.locator('input[type="radio"]').first()).not.toBeVisible();
  await expect(page.getByText("Default", { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: "/tmp/x402-cardano-ui-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: "/tmp/x402-cardano-ui-mobile.png", fullPage: true });
  await page.getByText("Advanced", { exact: true }).click();
  await expect(page.getByRole("radio", { name: "Native token 0.10 tUSDM" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

for (const mode of ["mainnet", "reject"] as const) {
  test(`${mode} wallet connection cannot enable a payment; a fresh connection works`, async ({ page, backend }) => {
    await openDemo(page, backend, mode);
    await page.getByRole("button", { name: "Fixture wallet Connect" }).click();
    await expect(page.getByRole("alert")).toContainText(mode === "mainnet" ? "mainnet" : "rejected");
    await expect(page.getByRole("button", { name: "Pay 2 tADA" })).toBeDisabled();
    await expect(page.getByText("Testnet wallet", { exact: true })).toHaveCount(0);
    await page.evaluate(() => { (window as unknown as { fixtureWalletMode: string }).fixtureWalletMode = "testnet"; });
    await connect(page);
    await expect(page.getByRole("button", { name: "Pay 2 tADA" })).toBeEnabled();
    await page.evaluate(({ mode }) => { (window as unknown as { fixtureWalletMode: string }).fixtureWalletMode = mode; }, { mode });
    await page.getByRole("button", { name: "Reconnect wallet" }).click();
    await expect(page.getByRole("alert")).toContainText(mode === "mainnet" ? "mainnet" : "rejected");
    await expect(page.getByRole("button", { name: "Pay 2 tADA" })).toBeDisabled();
    await expect(page.getByText("Testnet wallet", { exact: true })).toHaveCount(0);
    expect(backend.state.builds).toBe(0);
  });
}

test("pending settlement locks controls and resumes the identical signed payment", async ({ page, backend }) => {
  backend.state.confirmations = -1;
  await openDemo(page, backend);
  await connect(page);
  await page.getByRole("button", { name: "Pay 2 tADA" }).click();
  await expect(page.getByText("Settlement needs another check", { exact: true })).toBeVisible({ timeout: 25_000 });
  await expectLockedPayment(page);
  await expect(page.locator(".timeline > li.step-card").last()).toContainText("Check needed");
  await expect(page.getByText(/Automatic checks paused/)).toBeVisible();
  expect(await page.evaluate(() => !window.dispatchEvent(new Event("beforeunload", { cancelable: true })))).toBe(true);
  expect(backend.state.builds).toBe(1);
  expect(backend.state.broadcasts).toBe(1);
  backend.state.confirmations = 1;
  await page.getByRole("button", { name: "Check this payment again" }).click();
  await expect(page.getByRole("button", { name: "Start a new payment" })).toBeVisible();
  expect(await page.evaluate(() => !window.dispatchEvent(new Event("beforeunload", { cancelable: true })))).toBe(false);
  expect(backend.state.builds).toBe(1);
  expect(backend.state.broadcasts).toBe(1);
  expect(backend.paymentHeaders).toHaveLength(5);
  expect(new Set(backend.paymentHeaders).size).toBe(1);
  await expect(page.locator(".timeline > li.step-card")).toHaveCount(5);
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalOverflow(page);
});

test("a lost settlement response automatically recovers without signing again", async ({ page, backend }) => {
  let interruptFirstPaidResponse = true;
  await page.route("**/api/message?*", async route => {
    if (interruptFirstPaidResponse && route.request().headers()["payment-signature"]) {
      interruptFirstPaidResponse = false;
      // Let the real server settle, then simulate losing its HTTP response.
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await openDemo(page, backend);
  await connect(page);
  await page.getByRole("button", { name: "Pay 2 tADA" }).click();
  await expect(page.getByRole("button", { name: "Start a new payment" })).toBeVisible();
  expect(backend.state.builds).toBe(1);
  expect(backend.state.broadcasts).toBe(1);
  expect(backend.paymentHeaders).toHaveLength(2);
  expect(backend.paymentHeaders[1]).toBe(backend.paymentHeaders[0]);
});

async function expectNoHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test("pending escrow does not claim that funds are already confirmed in the lock", async ({ page, backend }) => {
  backend.state.confirmations = -1;
  await openDemo(page, backend);
  await connect(page);
  await page.getByText("Advanced", { exact: true }).click();
  await page.getByRole("radio", { name: "Masumi escrow 5 tADA" }).check();
  await page.getByRole("button", { name: "Lock 5 tADA in escrow" }).click();
  await expect(page.getByText("Settlement needs another check", { exact: true })).toBeVisible({ timeout: 25_000 });
  await expect(page.getByText(/is confirmed in the Masumi escrow lock|This payment uses Masumi escrow/)).toHaveCount(0);
  backend.state.confirmations = 1;
  await page.getByRole("button", { name: "Check this payment again" }).click();
  await expect(page.getByRole("button", { name: "Start a new payment" })).toBeVisible();
  expect(backend.state.builds).toBe(1);
  expect(backend.state.broadcasts).toBe(1);
  await expect(page.getByText(/This payment uses Masumi escrow/)).toBeVisible();
});

test("mempool-only acceptance is visibly distinct from on-chain confirmation", async ({ page, backend }) => {
  backend.state.confirmations = -1;
  await openDemo(page, backend);
  await connect(page);
  await page.getByText("Advanced", { exact: true }).click();
  await page.getByLabel("Confirmations before unlock").selectOption("-1");
  await expect(page.getByRole("button", { name: "Pay 2 tADA" })).toBeEnabled();
  await page.getByRole("button", { name: "Pay 2 tADA" }).click();
  await expect(page.getByRole("button", { name: "Start a new payment" })).toBeVisible();
  await expect(page.locator('.settled-artifact[data-outcome="mempool"]')).toBeVisible();
  await expect(page.getByText(/not yet confirmed in a block/)).toBeVisible();
  await expect(page.getByText("Confirmed on-chain", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/payment is confirmed on-chain/)).toHaveCount(0);
  expect(backend.state.broadcasts).toBe(1);
});

test("a rejected check explains the verification error and preserves recovery", async ({ page, backend }) => {
  backend.state.confirmations = -1;
  await openDemo(page, backend);
  await connect(page);
  await page.getByRole("button", { name: "Pay 2 tADA" }).click();
  await expect(page.getByText("Settlement needs another check", { exact: true })).toBeVisible({ timeout: 25_000 });
  // A verifier rejection (for example after a server restart) must still be
  // explained without discarding a transaction that may already be submitted.
  let rejectCheck = true;
  await page.route("**/api/message?*", route => rejectCheck
    ? route.fulfill({ status: 402, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "PAYMENT-REQUIRED", "PAYMENT-REQUIRED": encodePaymentRequiredHeader({ x402Version: 2, resource: { url: route.request().url() }, error: "invalid_exact_cardano_payload_nonce_not_on_chain", accepts: [] }) }, body: "{}" })
    : route.continue());
  await page.getByRole("button", { name: "Check this payment again" }).click();
  await expect(page.getByText(/The server rejected this payment check:.*nonce_not_on_chain/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Start a new payment" })).toHaveCount(0);
  rejectCheck = false;
  backend.state.spent = true;
  backend.state.confirmations = 1;
  await page.getByRole("button", { name: "Check this payment again" }).click();
  await expect(page.getByRole("button", { name: "Start a new payment" })).toBeVisible();
  expect(backend.state.builds).toBe(1);
  expect(backend.state.broadcasts).toBe(1);
  expect(new Set(backend.paymentHeaders).size).toBe(1);
});

for (const method of [
  { radio: "ADA payment 2 tADA", button: "Pay 2 tADA" },
  { radio: "Native token 0.10 tUSDM", button: "Pay 0.10 tUSDM" },
  { radio: "Masumi escrow 5 tADA", button: "Lock 5 tADA in escrow" },
  { radio: "Masumi with token 0.25 tUSDM", button: "Lock 0.25 tUSDM in escrow" },
]) {
  test(`${method.radio} automatically reaches receipt and resource with one signature`, async ({ page, backend }) => {
    backend.state.confirmations = -1;
    await openDemo(page, backend);
    await connect(page);
    await page.getByText("Advanced", { exact: true }).click();
    await page.getByRole("radio", { name: method.radio }).check();
    const pending = page.waitForResponse(response => response.status() === 402 && !!response.headers()["payment-response"]);
    await page.getByRole("button", { name: method.button, exact: true }).click();
    await pending;
    await expect(page.locator(".timeline > li.step-card").last()).toContainText("In progress");
    await expect(page.getByRole("button", { name: "Check this payment again" })).toHaveCount(0);
    backend.state.spent = true;
    backend.state.confirmations = 1;
    await expect(page.getByRole("button", { name: "Start a new payment" })).toBeVisible();
    await expect(page.locator(".timeline > li.step-card").last()).toContainText("Done");
    await expect(page.getByText(/Hello from x402 on Cardano!/)).toBeVisible();
    expect(backend.paymentHeaders).toHaveLength(2);
    expect(new Set(backend.paymentHeaders).size).toBe(1);
    expect(backend.state.builds).toBe(1);
    expect(backend.state.broadcasts).toBe(1);
  });
}

test("an expired pending payment shows a terminal failure instead of waiting forever", async ({ page, backend }) => {
  backend.state.confirmations = -1;
  await openDemo(page, backend);
  await connect(page);
  const pending = page.waitForResponse(response => response.status() === 402 && !!response.headers()["payment-response"]);
  await page.getByRole("button", { name: "Pay 2 tADA" }).click();
  await pending;
  backend.state.slotOffset = 1200;
  await expect(page.getByRole("alert")).toContainText("The transaction expired without settling");
  await expect(page.locator(".timeline > li.step-card").last()).toContainText("Failed");
  await expect(page.getByRole("button", { name: "Check this payment again" })).toHaveCount(0);
  expect(backend.state.builds).toBe(1);
  expect(backend.state.broadcasts).toBe(1);
  expect(new Set(backend.paymentHeaders).size).toBe(1);
});
