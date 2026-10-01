# x402 on Cardano

Pay for one HTTP request with a browser wallet on **Cardano preprod**, and watch every protocol message as it happens.

**What x402 is.** x402 turns HTTP's `402 Payment Required` status into a payment protocol. The server answers an unpaid request with a machine-readable price; the client pays and repeats the same request with proof of payment. There is no account, API key or checkout page. Three roles take part:

- the **client**: your browser and its wallet, which builds and signs the payment;
- the **resource server**: it sets the price and serves the content once paid;
- the **facilitator**: it checks the signed payment and puts it on chain for the server, so the server needs no blockchain code.

The client never broadcasts the payment itself. It hands the server a signed but unsubmitted transaction, so amount, recipient, asset and timing can be checked *before* any money moves, and the payment is tied to exactly this request. New to Cardano? The [guide's two-minute primer](docs/x402/guide.md#cardano-in-two-minutes) covers UTxOs, validity windows and confirmations.

It uses the official npm releases of [`@x402/cardano`](https://www.npmjs.com/package/@x402/cardano), `@x402/core` and `@x402/express`, pinned to **2.26.0**. No sibling checkout or upstream build is needed.

## Run it

You need:

- Node **22+**;
- a [Blockfrost](https://blockfrost.io) project created for the network **Cardano preprod** (its ID starts with `preprod`);
- a CIP-30 browser wallet such as [Eternl](https://eternl.io) or [Lace](https://www.lace.io), switched to the **Preprod** network;
- test ADA in that wallet from the [Cardano faucet](https://docs.cardano.org/cardano-testnets/tools/faucet/) (choose Preprod Testnet).

```sh
./setup.sh
```

This runs `npm ci` at the repository root and creates missing `.env` files without overwriting existing ones. Edit these values:

| File | Value |
|---|---|
| `facilitator/.env` | `BLOCKFROST_PROJECT_ID`: your preprod project ID |
| `server/.env` | `SERVER_CARDANO_ADDRESS`: your preprod receiving address; replace the example address. A second account in your own wallet works well: you can watch the 2 tADA arrive |
| `frontend/.env` | `VITE_BLOCKFROST_PROJECT_ID`: your preprod project ID |

The frontend key is visible in the browser. Use a project dedicated to this testnet demo. The facilitator needs a provider key but no funded wallet or mnemonic. Vite reads `frontend/.env` only when it starts, so restart after editing it.

```sh
npm run dev
```

Open **http://localhost:5173**. The page has two tabs: **Transactions**, an ordinary x402 payment for one HTTP resource, and **Masumi agent**, an AI agent hired through Masumi's escrow ([below](#the-masumi-agent-tab)). On Transactions, select **preprod** in your wallet, connect it and request the message. The first payment costs **2 tADA plus the network fee**. Both preprod and preview wallets report CIP-30 network ID `0`; the demo also checks wallet inputs against live preprod UTxOs before signing.

All services start together. The server briefly waits for the facilitator during startup.

| Component | Port | Responsibility |
|---|---|---|
| `frontend/` | 5173 | Show the HTTP flow; build and sign with CIP-30 |
| `server/` | 4021 | Issue payment offers and return the paid resource; forward the Masumi agent tab to its agent |
| `facilitator/` | 4022 | Verify, broadcast and observe the Transactions tab's payments |
| `masumi/` agent | 8787 | Optional, separate process for the Masumi agent tab (see [below](#the-masumi-agent-tab)); it has its own built-in facilitator |

**Using a hosted facilitator instead.** Set `FACILITATOR_URL` in `server/.env` and start only the server and the frontend: `npm run dev -w server` and `npm run dev -w frontend`. (`npm run dev` always starts the bundled facilitator too, which needs `BLOCKFROST_PROJECT_ID`.)

## Follow one payment

A payment takes five steps, numbered as on the Transactions tab:

- **01 The unpaid request.** The client asks for the message. The server responds with HTTP `402` and a `PAYMENT-REQUIRED` offer.
- **02 Server names its price.** The client decodes the offer: price, asset, recipient and how long it has to pay.
- **03 Wallet builds and signs.** The wallet builds and signs a transaction. **The browser never broadcasts it.**
- **04 Retried with proof of payment.** The client repeats the request with `PAYMENT-SIGNATURE`. The facilitator verifies it; the server prepares its response and holds it back while the facilitator broadcasts and waits for the requested confirmations.
- **05 Receipt and resource.** The server returns the message and a `PAYMENT-RESPONSE` receipt once settlement succeeds.

The [guide](docs/x402/guide.md#who-does-what) shows the same exchange as a sequence diagram.

**When settlement takes longer**, this happens automatically:

- The official server library retries settlement once with the same payload.
- The browser then keeps checking the same payment, reusing the original URL and signed bytes, with pauses growing from five to thirty seconds. It also checks again after an interrupted response. No extra wallet approval is needed.
- Step 05 completes on its own once the payment confirms. An unconfirmed transaction past its validity window (plus the SDK's grace period) ends with an explicit expiry failure. If the provider lookup fails, the bundled facilitator keeps the result pending rather than declaring expiry.

**When it stops and what you do:** an unexpected answer (a rejected check, an unreadable or mismatched receipt, a non-transient error), or 20 minutes without a result, pauses with **Check needed**. **Check this payment again** resumes the same payment. Keep the page open: this demo stores retry state in memory.

## Explore the advanced options

ADA is the starting point. Open **Advanced** for native tokens and confirmation depth. The method list and confirmation range come from the connected facilitator's capabilities.

| Route | Price | What happens |
|---|---|---|
| `GET /api/message` | 2 tADA (`2000000` lovelace) | Pay the receiving address |
| `GET /api/message-usdm` | 0.10 tUSDM (`100000` units) | Pay the receiving address in a native token |

Token payments require that exact preprod token in your wallet, plus ADA for fees and minimum output value. The token route is optional.

**Two different tUSDM tokens.** The Transactions tab's token route uses the SDK's preprod tUSDM (policy `e675b46e…`). The Masumi agent tab uses Masumi's tUSDM (policy `16a55b2a…`, from the [Masumi dispenser](https://dispenser.masumi.network/)). They share a name but are different assets. To pay the token route with dispenser tokens, set `USDM_ASSET=16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde.0014df10745553444d` in `server/.env`.

The default confirmation level is `1`: inclusion plus one newer block. Level `0` accepts block inclusion. Level `-1` accepts the facilitator's own broadcast acceptance and is offered only with `ACCEPT_MEMPOOL=true`; a mempool transaction may never become canonical. Preprod makes a block about every 20 seconds on average, so level N takes roughly (N + 1) × 20 seconds after submission. The default facilitator wait is 75 seconds per settlement call; deeper settings take more automatic checks, and the page keeps checking on its own.

## The Masumi agent tab

The second tab hires a real, registered [Masumi](https://masumi.network) agent and follows the money: the price is locked in Masumi's escrow contract, the agent does the job and puts the result hash on chain, and the seller collects after the unlock time. Pay over x402 with your wallet (Masumi tUSDM or tADA), or hire through Sokosumi with credits. **Replay an example** runs the same flow code against a simulated agent and wallet, with no setup at all.

`npm run dev` does not start the agent. Without it, the tab offers only **Replay an example**. Real hires need the agent registered on Masumi first. Its [guide](masumi/README.md) walks through it:

- a separate seller wallet with about 20 tADA;
- a public HTTPS URL for the agent (for example a Cloudflare tunnel);
- `npm install`, `npm run register` and `npm run agent` in `masumi/` (it is a separate package; `./setup.sh` does not install it);
- a different wallet as the buyer in the browser.

The agent's guide also covers collecting the payment afterwards. While it runs, this demo's server reaches it at `MASUMI_AGENT_URL` (default `http://127.0.0.1:8787`) and forwards the tab's requests under `/masumi`. Every request and transaction is documented in [masumi/docs/FLOWS.md](masumi/docs/FLOWS.md).

To hire through Sokosumi from the tab, set in `server/.env`:

| Variable | Value |
|---|---|
| `SOKOSUMI_API_KEY` | Your Sokosumi user API key. It stays in the server and spends your credits |
| `SOKOSUMI_AGENT_ID` or `SOKOSUMI_AGENT_NAME` | Your agent on Sokosumi (required with the key). The id is Sokosumi's own UUID, not the Masumi registry identifier |
| `SOKOSUMI_MAX_CREDITS` | Optional cap per hire |

The server's Sokosumi routes answer only the demo page (`FRONTEND_ORIGINS`, default `http://localhost:5173`) from this machine. **Never tunnel or expose the server while the key is set**; only the agent needs a public URL.

## Read or change the code

Read the code in the order a request travels.

**Transactions tab:**

1. [frontend/src/x402/flow.ts](frontend/src/x402/flow.ts): the client's HTTP loop and recovery.
2. [server/src/app.ts](server/src/app.ts): prices, the 402 and the payment middleware.
3. [frontend/src/x402/cip30Signer.ts](frontend/src/x402/cip30Signer.ts): build and sign with the wallet.
4. [facilitator/src/facilitator.ts](facilitator/src/facilitator.ts): verify and settle over HTTP; [settlement.ts](facilitator/src/settlement.ts) guards expiry.
5. [server/src/paymentOperations.ts](server/src/paymentOperations.ts): one transaction per application operation.

**Masumi agent tab:**

- buyer: [frontend/src/masumi/x402Flow.ts](frontend/src/masumi/x402Flow.ts) and [cip30Signer.ts](frontend/src/masumi/cip30Signer.ts);
- forwarding and the Sokosumi proxy: [server/src/masumi.ts](server/src/masumi.ts);
- seller with its built-in facilitator and watcher: [masumi/src/agent.ts](masumi/src/agent.ts).

The [developer guide](docs/x402/guide.md) explains the protocol and retry boundaries. The [machine reference](docs/x402/reference.agent.md) records wire fields, verification rules and exported error codes. The [official Cardano specification](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_cardano.md) is the protocol source.

```sh
npm run typecheck
npm run build
npm test
npm run test:browser
npm run verify:docs
```

The browser checks require Chromium installed for Playwright (`npx playwright install chromium`). Automated tests cover both payment routes, the Masumi agent tab (its flows, the `/masumi` server routes and a browser run), automatic recovery, expiry, replay and provider failures. They include the production CIP-30 signer and HTTP Blockfrost adapter against a local provider fixture. A real wallet-to-preprod payment is a separate manual check.

## Troubleshooting

- **`npm run dev` exits at once:** read the first error. The facilitator needs `BLOCKFROST_PROJECT_ID`; the server needs an `addr_test1…` `SERVER_CARDANO_ADDRESS`. One failing service stops the others.
- **No payment options:** check the facilitator and server logs, then use the configuration retry button. An external `FACILITATOR_URL` must advertise x402 v2 `exact` on `cardano:preprod`.
- **No live preprod inputs:** switch the wallet to preprod, fund it, and let its UTxO cache refresh. `addr_test1` alone also matches preview.
- **Blockfrost 402/429:** the provider project has hit a quota or rate limit. Provider failures stop signing; retry after resolving the provider error.
- **Pending or unknown payment:** keep the page open while automatic checks run; step 05 finishes by itself once the payment confirms. If checks pause, check the same payment. Provider errors appear alongside the pending status when available. A Blockfrost transaction lookup returns “unknown” before inclusion; it is not proof of rejection. Do not start another payment to resolve an uncertain result.
- **Provider evaluation/submission failure:** the official adapter uses Blockfrost’s transaction evaluation endpoint even for ordinary payments. Check provider availability and the facilitator log. Some published adapter errors omit the underlying Blockfrost response body; an ambiguous submission failure must be checked until confirmation or explicit expiry.
- **Rejected payment:** the UI reads the protocol error headers; the server logs verification and settlement reasons. Check those before changing the configuration.
- **Masumi agent tab says the agent isn't reachable:** start it with `npm run agent` in `masumi/` (after registering it), or use **Replay an example**.
- **Sokosumi "does not show … to your account":** check that `SOKOSUMI_AGENT_ID` is Sokosumi's UUID, not `MASUMI_AGENT_IDENTIFIER`, and that the agent shows in your Sokosumi catalog.

This is a local, single-process teaching demo. Payment-operation records and facilitator settlement records are process-local. Restarting services loses that state; production or multiple-instance deployments need durable, atomic storage and application-level idempotency.
