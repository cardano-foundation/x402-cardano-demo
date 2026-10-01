import { readFileSync } from "node:fs";
import { test as base, expect, type Page } from "@playwright/test";
import express from "express";
import { x402Facilitator } from "@x402/core/facilitator";
import type { SupportedResponse } from "@x402/core/types";
import { ExactCardanoScheme } from "@x402/cardano/exact/facilitator";
import { createSokosumi } from "../masumi/src/sokosumi.ts";
import { createResourceApp } from "../server/src/app.ts";
import { createFixture, seller } from "./fixtures.ts";

// The light, one-screen layout (docs/plans/2026-10-01-light-one-screen.md).
// The sizes are browser content areas: a 1440×900 and a 1280×800 screen
// leave about 1440×800 and 1280×680 for the page.

const SCREENS = [{ width: 1440, height: 800 }, { width: 1280, height: 680 }];
const ESCROW = "addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g";

type Backend = Awaited<ReturnType<typeof createFixture>>;

const test = base.extend<{ backend: Backend }>({
  backend: async ({}, use) => {
    const agent = express();
    agent.get("/availability", (_req, res) => { res.json({ status: "available" }); });
    agent.get("/demo/config", (_req, res) => {
      res.json({ agentIdentifier: `67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b10${"ee".repeat(28)}000000`, sellerAddress: seller.sellerAddress, escrowAddress: ESCROW,
        offers: [
          { path: "/x402/start_job", amount: "1000000", asset: "16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde.0014df10745553444d", resource: "https://agent.example/x402/start_job", registered: true },
          { path: "/x402/start_job/ada", amount: "5000000", asset: "lovelace", resource: "https://agent.example/x402/start_job/ada", registered: false },
        ] });
    });
    const agentServer = agent.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => agentServer.once("listening", resolve));
    const reply = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ data }), text: async () => "" });
    const sokosumi = createSokosumi({ baseUrl: "https://soko.test/v1", apiKey: "layout-test-key", agentName: "demo", agentId: "agent-1", fetch: async () => reply({}) });

    const fixture = await createFixture();
    const facilitator = new x402Facilitator().register("cardano:preprod", new ExactCardanoScheme(fixture.chain, { confirmationTimeoutMs: 10, confirmationPollMs: 1, acceptMempool: true }));
    const app = await createResourceApp({
      facilitator: { getSupported: async () => facilitator.getSupported() as SupportedResponse, verify: (p, r) => facilitator.verify(p, r), settle: (p, r) => facilitator.settle(p, r) },
      payTo: seller.sellerAddress,
      masumi: { agentUrl: `http://127.0.0.1:${(agentServer.address() as { port: number }).port}`, frontendOrigins: ["http://127.0.0.1:44020"], sokosumi: { client: sokosumi } },
    });
    const listener = app.listen(44021, "127.0.0.1");
    await new Promise<void>((resolve, reject) => { listener.once("listening", resolve); listener.once("error", reject); });
    try { await use(fixture); }
    finally {
      for (const server of [listener, agentServer]) {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    }
  },
});

/** The fixture wallet, as in browser.spec.ts: the page signs through the test chain. */
async function open(page: Page, backend: Backend, path = "/") {
  await page.exposeFunction("fixtureSign", backend.client.buildAndSignPaymentTransaction);
  await page.addInitScript(() => {
    (window as unknown as { cardano: unknown }).cardano = {
      fixture: { name: "Fixture wallet", enable: async () => ({ getNetworkId: async () => 0 }) },
    };
  });
  await page.route("**/src/x402/cip30Signer.ts*", route => route.fulfill({
    contentType: "application/javascript",
    body: `export async function createCip30Signer() { return {
      getAddress: () => ${JSON.stringify(backend.payer)},
      buildAndSignPaymentTransaction: input => window.fixtureSign(input)
    }; }`,
  }));
  await page.goto(path);
}

/** No page scroll, nothing clipped: overflowing columns scroll themselves and nothing overflows sideways. */
async function expectOneScreen(page: Page) {
  const report = await page.evaluate(() => {
    const regions = [...document.querySelectorAll<HTMLElement>(".dash__col, .dash__scroll")].map(el => ({
      name: el.className,
      overflowing: el.scrollHeight > el.clientHeight + 1,
      overflowY: getComputedStyle(el).overflowY,
      wide: el.scrollWidth > el.clientWidth + 1,
    }));
    return {
      fits: document.documentElement.scrollHeight <= window.innerHeight,
      html: getComputedStyle(document.documentElement).overflowY,
      body: getComputedStyle(document.body).overflowY,
      regions,
    };
  });
  expect(report.fits, "the page itself must not scroll").toBe(true);
  expect(report.html).not.toBe("hidden");
  expect(report.body).not.toBe("hidden");
  expect(report.regions.length).toBeGreaterThan(1);
  for (const region of report.regions) {
    if (region.overflowing) expect(["auto", "scroll"], `${region.name} overflows without scrolling`).toContain(region.overflowY);
    expect(region.wide, `${region.name} overflows sideways`).toBe(false);
  }
}

/** When the steps list overflows, the run must have scrolled it towards the newest step. */
async function expectFollowed(page: Page, selector: string) {
  const list = await page.locator(selector).evaluate(el => ({ overflows: el.scrollHeight > el.clientHeight + 1, top: el.scrollTop }));
  if (list.overflows) expect(list.top, `${selector} followed the run`).toBeGreaterThan(0);
}

for (const screen of SCREENS) {
  test.describe(`${screen.width}×${screen.height}`, () => {
    test.use({ viewport: screen });

    test("Transactions fits one screen, idle and after a finished payment", async ({ page, backend }) => {
      await open(page, backend);
      await page.getByRole("button", { name: "Fixture wallet Connect" }).click();
      await expect(page.getByText("Testnet wallet", { exact: true })).toBeVisible();
      await expectOneScreen(page);
      await expect(page.getByRole("button", { name: "Pay 2 tADA" })).toBeInViewport({ ratio: 1 });

      await page.getByRole("button", { name: "Pay 2 tADA" }).click();
      await expect(page.getByRole("button", { name: "Start a new payment" })).toBeVisible({ timeout: 25_000 });
      await expect(page.getByRole("button", { name: "Start a new payment" })).toBeInViewport({ ratio: 1 });
      await expectOneScreen(page);
      await expect(page.locator(".timeline > li.step-card").last()).toBeInViewport({ ratio: 0.2 });
      await expectFollowed(page, ".dash__main .dash__scroll");
    });

    test("Masumi fits one screen with the agent reachable, and after a replay", async ({ page, backend }) => {
      await open(page, backend, "/#masumi");
      await expect(page.getByRole("radio", { name: /Through Sokosumi/ })).toBeVisible();
      await expectOneScreen(page);
      await expect(page.getByRole("button", { name: "Pay 1.00 tUSDM and run" })).toBeInViewport({ ratio: 1 });
      await expect(page.getByRole("button", { name: "Replay an example" })).toBeInViewport({ ratio: 1 });

      await page.getByRole("button", { name: "Replay an example" }).click();
      await expect(page.locator(".masumi-steps .step-card[data-status='done']")).toHaveCount(8, { timeout: 30_000 });
      await expectOneScreen(page);
      await expect(page.locator(".masumi-steps > li.step-card").last()).toBeInViewport();
      await expectFollowed(page, ".masumi-run .dash__scroll");
      await expect(page.locator(".money-rail")).toBeInViewport();
      await expect(page.getByText("example run: simulated, no money moves")).toBeVisible();
    });
  });
}

test("at the 1100 px boundary the Masumi step titles stay on at most two lines", async ({ page, backend }) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await open(page, backend, "/#masumi");
  await expect(page.locator(".masumi-step__title").first()).toBeVisible();
  const lines = await page.locator(".masumi-step__title").evaluateAll(titles =>
    titles.map(title => Math.round(title.getBoundingClientRect().height / parseFloat(getComputedStyle(title).lineHeight))));
  expect(Math.max(...lines)).toBeLessThanOrEqual(2);
});

test("on a phone both tabs stack and nothing overflows sideways", async ({ page, backend }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, backend);
  for (const path of ["/", "/#masumi"]) {
    await page.goto(path);
    await page.reload();
    await page.waitForSelector(".dash__col");
    const layout = await page.evaluate(() => ({
      wide: document.documentElement.scrollWidth > window.innerWidth,
      columns: [...document.querySelectorAll<HTMLElement>(".dash__col")].map(el => {
        const box = el.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, left: box.left, wide: el.scrollWidth > el.clientWidth + 1 };
      }),
    }));
    expect(layout.wide, path).toBe(false);
    layout.columns.forEach((column, i) => {
      expect(column.wide, `${path} column ${i}`).toBe(false);
      if (i === 0) return;
      expect(column.top, `${path} column ${i} is below the previous one`).toBeGreaterThanOrEqual(layout.columns[i - 1].bottom - 1);
      expect(Math.abs(column.left - layout.columns[0].left), `${path} column ${i} is aligned`).toBeLessThanOrEqual(1);
    });
  }
});

test("the long explanations moved into About, and the key notes stay visible", async ({ page, backend }) => {
  await open(page, backend);
  await expect(page.getByText(/Testnet ADA on/)).toBeVisible();
  await page.getByText("About this demo").click();
  await expect(page.getByText(/turns HTTP.s oldest unused status code/)).toBeVisible();
  await expect(page.getByText(/Holds the funds and signs the transaction/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Cardano package guide" })).toBeVisible();

  await page.getByRole("tab", { name: /Masumi agent/ }).click();
  await expect(page.getByRole("link", { name: /dispenser/ })).toBeVisible();
  await expect(page.getByText(/preprod has a second tUSDM that does not count/)).toBeVisible();
  await page.getByText("About this demo").click();
  await expect(page.getByText(/lists AI agents on Cardano and pays them through an escrow contract/)).toBeVisible();
  await expect(page.getByText(/The vested_pay smart contract holding the money/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Cardano package guide" })).toBeVisible();
});

test("the page is light only: every colour is a token", () => {
  const html = readFileSync(new URL("../frontend/index.html", import.meta.url), "utf8");
  expect(html).toContain('name="color-scheme" content="light"');
  expect(html).not.toMatch(/#0a0d12/i);
  for (const file of ["../frontend/src/styles.css", "../frontend/src/masumi/masumi.css"]) {
    const css = readFileSync(new URL(file, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const outsideRoot = css.replace(/:root\s*\{[^}]*\}/g, "");
    const values = [...outsideRoot.matchAll(/:\s*([^;{}]+);/g)].map(m => m[1]);
    const literals = values.filter(value =>
      /#[0-9a-f]{3,8}\b/i.test(value) || /\b(rgba?|hsla?|oklch|color-mix)\(/i.test(value) || /(^|[\s,(])(white|black|gr[ae]y)($|[\s,)])/i.test(value));
    expect(literals, `${file} has colours outside :root`).toEqual([]);
  }
});

test("the inspector can be resized by dragging or with the keyboard, within limits, and remembers its width", async ({ page, backend }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await open(page, backend, "/#masumi");
  const handle = page.getByRole("separator", { name: "Resize the step inspector" });
  const inspector = page.locator(".dash__detail");
  const steps = page.locator(".masumi-run");
  const width = async (locator: typeof inspector) => (await locator.boundingBox())!.width;
  const before = await width(inspector);

  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 60, box.y + 200, { steps: 5 });
  await page.mouse.up();
  expect(Math.abs((await width(inspector)) - (before + 60))).toBeLessThanOrEqual(4);
  await expectOneScreen(page);

  // Dragging far left stops where the steps column keeps its minimum width.
  const far = (await handle.boundingBox())!;
  await page.mouse.move(far.x + 3, far.y + 200);
  await page.mouse.down();
  await page.mouse.move(100, far.y + 200, { steps: 5 });
  await page.mouse.up();
  expect(await width(steps)).toBeGreaterThanOrEqual(379);
  await expectOneScreen(page);

  await handle.focus();
  await page.keyboard.press("End");
  expect(Math.round(await width(inspector))).toBe(360);
  await page.keyboard.press("ArrowLeft");
  expect(Math.round(await width(inspector))).toBe(384);

  await page.reload();
  await expect(page.getByRole("separator", { name: "Resize the step inspector" })).toBeVisible();
  expect(Math.round(await width(inspector))).toBe(384);

  await page.getByRole("separator", { name: "Resize the step inspector" }).dblclick();
  expect(Math.abs((await width(inspector)) - before)).toBeLessThanOrEqual(2);
});

test("on a phone there is no splitter", async ({ page, backend }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, backend, "/#masumi");
  await page.waitForSelector(".dash__col");
  await expect(page.getByRole("separator", { name: "Resize the step inspector" })).toBeHidden();
});
