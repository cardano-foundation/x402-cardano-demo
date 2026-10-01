import { test as base, expect } from "@playwright/test";
import express from "express";
import { x402Facilitator } from "@x402/core/facilitator";
import type { SupportedResponse } from "@x402/core/types";
import { ExactCardanoScheme } from "@x402/cardano/exact/facilitator";
import { createSokosumi } from "../masumi/src/sokosumi.ts";
import { createResourceApp } from "../server/src/app.ts";
import { createFixture, seller } from "./fixtures.ts";

// The Masumi tab in a real browser. The page talks to the real server app
// (port 44021, as playwright.config.ts sets VITE_SERVER_URL); the Masumi agent
// and the Sokosumi API are fakes, so nothing touches a chain or a marketplace.

const ESCROW = "addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g";

const test = base.extend<{ backend: { sokosumiPosts: () => number } }>({
  backend: async ({}, use) => {
    const agent = express();
    agent.get("/availability", (_req, res) => { res.json({ status: "available" }); });
    agent.get("/demo/config", (_req, res) => {
      res.json({ agentIdentifier: `67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b10${"ee".repeat(28)}000000`, sellerAddress: seller.sellerAddress, escrowAddress: ESCROW,
        offers: [{ path: "/x402/start_job", amount: "1000000", asset: "16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde.0014df10745553444d", resource: "https://agent.example/x402/start_job", registered: true }] });
    });
    const agentServer = agent.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => agentServer.once("listening", resolve));

    let posts = 0;
    const reply = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ data }), text: async () => "" });
    const sokosumi = createSokosumi({ baseUrl: "https://soko.test/v1", apiKey: "browser-test-key", agentName: "demo", agentId: "agent-1",
      fetch: async (url, init) => {
        if (url.endsWith("/input-schema")) return reply({ input_data: [] });
        if (init?.method === "POST") { posts++; return reply({ id: "job-1", status: "payment_pending", result: null, name: "Demo UI: hello masumi" }); }
        return reply({ id: "job-1", status: "completed", result: "IMUSAM OLLEH", name: "Demo UI: hello masumi" });
      } });

    const fixture = await createFixture();
    const facilitator = new x402Facilitator().register("cardano:preprod", new ExactCardanoScheme(fixture.chain, { confirmationTimeoutMs: 10, confirmationPollMs: 1 }));
    const app = await createResourceApp({
      facilitator: { getSupported: async () => facilitator.getSupported() as SupportedResponse, verify: (p, r) => facilitator.verify(p, r), settle: (p, r) => facilitator.settle(p, r) },
      payTo: seller.sellerAddress,
      masumi: { agentUrl: `http://127.0.0.1:${(agentServer.address() as { port: number }).port}`, frontendOrigins: ["http://127.0.0.1:44020"], sokosumi: { client: sokosumi } },
    });
    const listener = app.listen(44021, "127.0.0.1");
    await new Promise<void>((resolve, reject) => { listener.once("listening", resolve); listener.once("error", reject); });
    try { await use({ sokosumiPosts: () => posts }); }
    finally {
      for (const server of [listener, agentServer]) {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    }
  },
});

test("the tabs switch demos, keep the choice in the URL and follow the arrow keys", async ({ page }) => {
  await page.goto("/");
  const transactions = page.getByRole("tab", { name: /Transactions/ });
  const masumi = page.getByRole("tab", { name: /Masumi agent/ });
  await expect(transactions).toHaveAttribute("aria-selected", "true");
  await masumi.click();
  await expect(masumi).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/#masumi$/);
  await expect(page.getByRole("heading", { name: /Hire an agent/ })).toBeVisible();
  await masumi.press("ArrowLeft");
  await expect(transactions).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: /402 isn.t an error/ })).toBeVisible();
  await page.goto("/#masumi");
  await expect(page.getByRole("tab", { name: /Masumi agent/ })).toHaveAttribute("aria-selected", "true");
});

test("without an agent the tab says how to start it, and the example replay still runs", async ({ page }) => {
  await page.goto("/#masumi");
  await expect(page.getByText("The agent isn't reachable.")).toBeVisible();
  await expect(page.getByText("npm run agent", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Replay an example" }).click();
  await expect(page.locator(".masumi-steps .step-card[data-status='done']")).toHaveCount(8, { timeout: 30_000 });
  await expect(page.locator(".money-rail")).toHaveAttribute("data-money", "reported");

  await page.getByRole("button", { name: /Ask for the job, get a 402 offer/ }).click();
  const inspector = page.locator(".inspector");
  await expect(inspector.getByText("402 Payment Required")).toBeVisible();
  await expect(inspector.locator(".x402-header dt", { hasText: "payment-required" })).toBeVisible();
  await expect(inspector.getByText(/The seller's offer: price, escrow address/)).toBeVisible();

  await page.getByRole("button", { name: /The agent finds the lock on chain/ }).click();
  await inspector.getByRole("tab", { name: "Escrow datum" }).click();
  await expect(inspector.getByText("18 · state")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("hiring through Sokosumi runs through the server's proxy once and shows the result", async ({ page, backend }) => {
  await page.goto("/#masumi");
  await page.getByRole("radio", { name: /Through Sokosumi/ }).check();
  await expect(page.getByText(/Not needed for Sokosumi/)).toBeVisible();
  await page.getByRole("button", { name: "Hire via Sokosumi" }).click();
  await expect(page.locator(".masumi-steps .step-card[data-status='done']")).toHaveCount(6, { timeout: 20_000 });
  await page.getByRole("button", { name: /Sokosumi delivers the result/ }).click();
  await page.locator(".inspector").getByRole("tab", { name: "Step data" }).click();
  await expect(page.locator(".inspector").getByText("IMUSAM OLLEH")).toBeVisible();
  expect(backend.sokosumiPosts()).toBe(1);
});
