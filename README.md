# x402 on Cardano

Pay for one HTTP request with a browser wallet on **Cardano preprod**. The demo shows the offer, signed transaction and settlement receipt as they pass between a client, resource server and facilitator.

It uses the official npm releases of [`@x402/cardano`](https://www.npmjs.com/package/@x402/cardano), `@x402/core` and `@x402/express`, pinned to **2.26.0**. No sibling checkout or upstream build is needed.

## Run it

You need Node **22+**, a Blockfrost **preprod** project ID, and a CIP-30 browser wallet with preprod ADA. Get test ADA from the [Cardano faucet](https://docs.cardano.org/cardano-testnets/tools/faucet/).

```sh
./setup.sh
```

This runs `npm ci` at the repository root and creates missing `.env` files without overwriting existing ones. Edit these values:

| File | Value |
|---|---|
| `facilitator/.env` | `BLOCKFROST_PROJECT_ID`: your preprod project ID |
| `server/.env` | `SERVER_CARDANO_ADDRESS`: your preprod receiving address; replace the example address |
| `frontend/.env` | `VITE_BLOCKFROST_PROJECT_ID`: your preprod project ID |

The frontend key is visible in the browser. Use a project dedicated to this testnet demo. The facilitator needs a provider key but no funded wallet or mnemonic.

```sh
npm run dev
```

Open **http://localhost:5173**, select **preprod** in your wallet, connect it and request the message. The first payment costs **2 tADA plus the network fee**. Both preprod and preview wallets report CIP-30 network ID `0`; the demo also checks wallet inputs against live preprod UTxOs before signing.

All services start together. The server briefly waits for the facilitator during startup.

| Component | Port | Responsibility |
|---|---|---|
| `frontend/` | 5173 | Show the HTTP flow; build and sign with CIP-30 |
| `server/` | 4021 | Issue payment offers and return the paid resource |
| `facilitator/` | 4022 | Verify, broadcast and observe the signed transaction |

## Follow one payment

1. The client requests a message. The server responds with HTTP `402` and a `PAYMENT-REQUIRED` offer.
2. The wallet builds and signs a transaction. **The browser never broadcasts it.**
3. The client repeats the request with `PAYMENT-SIGNATURE`.
4. The facilitator verifies it. The resource handler prepares its response; the middleware buffers it while the facilitator broadcasts and waits for the requested confirmations.
5. The server returns the message and a `PAYMENT-RESPONSE` receipt when settlement succeeds.

If settlement is still pending, the official server library retries settlement once with the same payload. The browser then makes up to **three automatic checks**, five seconds apart, reusing the original URL and signed bytes. It also checks again after an interrupted response; no extra wallet approval is needed. Each request can take a few minutes. If checks pause, step 05 shows **Check needed** and **Check this payment again** resumes the same payment. A confirmed payment unlocks the resource; an unconfirmed transaction past its validity window and the SDK’s grace period returns an explicit expiry failure. If the provider lookup fails, the bundled facilitator keeps the result pending rather than declaring expiry. Keep the page open: this demo stores retry state in memory.

## Explore the advanced options

ADA is the starting point. Open **Advanced** for native tokens, escrow and confirmation depth. The method list and confirmation range come from the connected facilitator's capabilities.

| Route | Price | What happens |
|---|---|---|
| `GET /api/message` | 2 tADA (`2000000` lovelace) | Pay the receiving address |
| `GET /api/message-usdm` | 0.10 tUSDM (`100000` units) | Pay the receiving address in a native token |
| `GET /api/message-masumi` | 5 tADA (`5000000` lovelace) | Lock ADA in Masumi escrow |
| `GET /api/message-masumi-usdm` | 0.25 tUSDM (`250000` units) | Lock a native token in Masumi escrow |

Token payments require that exact preprod token in your wallet, plus ADA for fees and minimum output value. `USDM_ASSET` can override the default token on the server.

For Masumi, connect a buyer wallet separate from the seller configured by `MASUMI_SELLER_MNEMONIC`. Masumi rejects identical buyer and seller payout addresses. The demo explains this before requesting a wallet signature.

The default confirmation level is `1`: inclusion plus one newer block. Level `0` accepts block inclusion. Level `-1` accepts the facilitator's own broadcast acceptance and is offered only with `ACCEPT_MEMPOOL=true`; a mempool transaction may never become canonical. Higher levels take longer. The default facilitator wait is 75 seconds per settlement call, so deeper settings can need another check.

**Masumi locks real testnet funds in escrow.** This demo has no release, refund or dispute workflow. Its x402 seller authorization signs `termsDigest`, which is not compatible with the stock Masumi Payment Service lifecycle signature flow. Do not assume those APIs can recover these deposits. The default seller uses a public test phrase and needs no funds to sign offers. Use the ADA route first; see the [Masumi explanation](docs/x402/guide.md#masumi-is-an-escrow-lock) before trying escrow.

## Read or change the code

Start with [server/src/app.ts](server/src/app.ts), then [frontend/src/x402/flow.ts](frontend/src/x402/flow.ts). The remaining Cardano-specific browser work is in [cip30Signer.ts](frontend/src/x402/cip30Signer.ts); [facilitator.ts](facilitator/src/facilitator.ts) wraps the official implementation.

The [developer guide](docs/x402/guide.md) explains the protocol and retry boundaries. The [machine reference](docs/x402/reference.agent.md) records wire fields, verification rules and exported error codes. The [official Cardano specification](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_cardano.md) is the protocol source.

```sh
npm run typecheck
npm run build
npm test
npm run test:browser
npm run verify:docs
```

The browser checks require Chromium installed for Playwright (`npx playwright install chromium`). Automated tests cover all four routes, automatic recovery, expiry, replay and provider failures. They include the production CIP-30 signer and HTTP Blockfrost adapter against a local provider fixture. A real wallet-to-preprod payment is a separate manual check.

## Troubleshooting

- **No payment options:** check the facilitator and server logs, then use the configuration retry button. An external `FACILITATOR_URL` must advertise x402 v2 `exact` on `cardano:preprod`.
- **No live preprod inputs:** switch the wallet to preprod, fund it, and let its UTxO cache refresh. `addr_test1` alone also matches preview.
- **Blockfrost 402/429:** the provider project has hit a quota or rate limit. Provider failures stop signing; retry after resolving the provider error.
- **Pending or unknown payment:** keep the page open while automatic checks run. If they pause, check the same payment. Provider errors appear alongside the pending status when available. A Blockfrost transaction lookup returns “unknown” before inclusion; it is not proof of rejection. Do not start another payment to resolve an uncertain result.
- **Provider evaluation/submission failure:** the official adapter uses Blockfrost’s transaction evaluation endpoint even for ordinary payments. Check provider availability and the facilitator log. Some published adapter errors omit the underlying Blockfrost response body; an ambiguous submission failure must be checked until confirmation or explicit expiry.
- **Rejected payment:** the UI reads the protocol error headers; the server logs verification and settlement reasons. Check those before changing the configuration.

This is a local, single-process teaching demo. Payment-operation records, issued Masumi quotes and facilitator settlement records are process-local. Restarting services loses that state; production or multiple-instance deployments need durable, atomic storage and application-level idempotency.
