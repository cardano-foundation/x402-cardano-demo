# x402 for Cardano developers

This guide follows the demo using the official **2.26.0** npm artifacts. It is written for developers who know HTTP and JavaScript and want to learn how x402 works on Cardano. If Cardano is new to you, read the primer below first. The [machine reference](reference.agent.md) collects the wire contract and exported errors; the [official Cardano specification](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_cardano.md) defines the protocol.

**Code map, in the order a request travels:**

1. `frontend/src/x402/flow.ts`: the client's HTTP loop and recovery.
2. `server/src/app.ts`: prices, the 402 and the payment middleware.
3. `frontend/src/x402/cip30Signer.ts`: building and signing with the browser wallet.
4. `facilitator/src/facilitator.ts`: verify and settle over HTTP.

The Masumi agent tab's buyer code is in `frontend/src/masumi/`; its seller is the agent in `masumi/src/agent.ts`.

## Cardano in two minutes

- **UTxOs.** Funds are discrete unspent transaction outputs, like coins in a wallet. A transaction consumes whole inputs and creates new outputs, with change returned to the payer. Each output can be spent only once.
- **The nonce is an input.** On account-based chains, x402 uses a random nonce in a signed authorization. On Cardano, one of the inputs the payment spends (`txHash#index`) serves as the nonce, and the ledger itself prevents reuse.
- **Validity window.** The wallet builds the transaction so it becomes invalid after `now + maxTimeoutSeconds` (600 s here). After that it can never land, which is how an expired payment becomes final.
- **Minimum ADA.** Every output must carry some ADA. A token payment therefore also needs ADA, on top of the token price and the fee.
- **Lovelace.** 1 tADA = 1,000,000 lovelace. Amounts on the wire are in lovelace or in a token's base units.
- **Confirmations.** Preprod produces a block about every 20 seconds on average. Level N means N further blocks on top of the one that includes the payment, so expect roughly (N + 1) × 20 seconds.
- **Preprod and preview.** These are two separate public testnets with different test ADA. Wallets report both as network `0`, so the demo also checks wallet inputs against preprod before signing.
- **CIP-30.** The standard browser-wallet API (`window.cardano.<wallet>.enable()`). The page asks the wallet for its UTxOs and for a signature; it never sees private keys.

## One request, one payment

x402 uses HTTP `402 Payment Required` to let a server quote a price before serving a resource. A client can read the offer, authorize payment and repeat its request without an account or checkout session.

The demo's first request is an ordinary GET. Its URL includes a random `requestId` for the application operation and the selected `confirmations` level. The server returns a base64-encoded JSON offer in `PAYMENT-REQUIRED`. A simplified decoded offer is:

```json
{
  "x402Version": 2,
  "resource": { "url": "http://localhost:4021/api/message?requestId=example&confirmations=1" },
  "accepts": [{
    "scheme": "exact",
    "network": "cardano:preprod",
    "amount": "2000000",
    "asset": "lovelace",
    "payTo": "addr_test1...",
    "maxTimeoutSeconds": 600,
    "extra": {
      "assetTransferMethod": "default",
      "areFeesSponsored": false,
      "confirmationPolicy": { "l1Confirmations": 1 }
    }
  }]
}
```

The client chooses an offer, builds and signs a complete Cardano transaction, and repeats the same GET with `PAYMENT-SIGNATURE`. Despite its name, this header contains the entire x402 `PaymentPayload`: the accepted requirements and a Cardano payload containing `transaction` and `nonce`. The transaction is fully signed CBOR encoded as base64. The nonce names an input, `txHash#index`.

On success, the server returns the message plus `PAYMENT-RESPONSE`, another base64-encoded JSON object containing the settlement result and transaction hash. Use the official header codecs from `@x402/core/http`; avoid hand-building protocol envelopes.

## Who does what

The **browser** uses `@x402/core` to choose and encode the offer, `@x402/cardano/exact/client` to construct its payment payload, and a small CIP-30 adapter to build and sign through the connected wallet. The official mnemonic signer cannot replace a browser wallet adapter. The client explicitly allows the selected asset and caps its amount, including ADA; the core library's default spend policy is not a blanket authorization for every asset.

The **resource server** registers `@x402/cardano/exact/server` with `x402ResourceServer` and uses `@x402/express` middleware. It owns prices, routes and application operation identity. It discovers the facilitator's capabilities before serving paid routes.

The **facilitator** wraps `@x402/cardano/exact/facilitator`. Its provider-only signer reads chain state and submits transactions. It has no mnemonic, spends no inputs of its own, and signs nothing. The payer funds the transaction fee and every output.

**Why the browser never broadcasts.** The client hands over a signed but unsubmitted transaction. That lets the server, through its facilitator, check amount, recipient, asset and timing *before* any money moves, decide when to submit, and tie that exact transaction to this request. If the client broadcast the payment itself, the server would have to find an unknown transaction on chain afterwards, and a wrong payment would already be spent.

Every Cardano method in the current scheme uses the same authorization ordering:

```mermaid
sequenceDiagram
    participant C as Browser
    participant S as Resource server
    participant F as Facilitator
    participant L as Cardano preprod
    C->>S: GET resource
    S-->>C: 402 + PAYMENT-REQUIRED
    Note over C: Build and sign, without broadcasting
    C->>S: Same GET + PAYMENT-SIGNATURE
    S->>F: verify
    F->>L: Read inputs and protocol parameters
    F-->>S: Verification result
    Note over S: Run idempotent handler; buffer response
    S->>F: settle
    F->>L: Broadcast signed transaction; observe evidence
    F-->>S: Settlement result
    S-->>C: Resource + PAYMENT-RESPONSE when successful
```

The handler runs before settlement. The Express middleware withholds its response until settlement succeeds, but it cannot undo a handler's side effects. A paid retry can run the handler again. Any real application must make those effects idempotent or otherwise reconcile them safely.

## Networks and assets

This demo supports `cardano:preprod`. The scheme also defines `cardano:mainnet` and `cardano:preview`. These names use CAIP-2 syntax, the cross-chain `namespace:reference` format for network identifiers. The specification also defines fixed aliases for these networks (from CIP-34), which implementations should normalize before matching.

CIP-30's network ID `0` covers both preprod and preview. A testnet address alone is therefore insufficient. Before signing, the adapter queries preprod for wallet inputs at every owning address, filters out spent inputs, and fails if the provider cannot establish which inputs are live. A provider error must never be treated as proof that the wallet's cached UTxOs are spendable.

ADA is named `lovelace`; one ADA is `1000000` lovelace. Native assets use `policyId.assetNameHex`. The default preprod tUSDM asset comes from the official `USDM_PREPROD_ASSET` export. A token with the same display name but a different policy is a different asset.

A native-token output also needs ADA. The transaction builder computes its minimum using live protocol parameters. That ADA and the network fee are additional to the token price. Masumi has a stricter calculation because its datum grows during later contract transitions; the official `buildMasumiLock()` helper calculates the initial locked lovelace.

## What verification establishes

The specification has nine numbered checks. The published facilitator implements them; the demo adds none of its own. "Phase-1" below means the ledger's ordinary transaction checks (signatures, input values, fees), as opposed to running smart-contract scripts.

| Rule | What it protects |
|---|---|
| 1 — Network | Transaction and selected requirements target the same network. |
| 2 — Recipient | A payment output goes to the required address. |
| 3 — Amount | The relevant output pays enough of the required asset. Masumi additionally requires exact lock values. |
| 4 — Asset | The asset identifier matches; equal market value is not a substitute. |
| 5 — Nonce | The declared UTxO is a transaction input and is available before first submission. |
| 6 — Transaction validity | Check signatures, available input values, conservation and applicable ledger constraints before broadcast. |
| 7 — TTL | The validity window is unexpired and bounded by the offer's timeout before first submission. |
| 8 — Minimum UTxO | Check output ADA against live protocol parameters when available. |
| 9 — Confirmation | Release the response only when authenticated evidence meets the offer's policy. |

The standard facilitator handles ordinary key-input transactions. Unusual ledger features can require a complete node-backed phase-1 validator; they are outside this demo's transaction construction. Masumi adds schema, signed-term, escrow-address, datum, value and deadline checks. The general `script` method exists in the specification but is not offered by this UI.

## Replay and retries are different problems

A nonce is a real consumed UTxO, not an arbitrary random string. The ledger prevents two transactions from spending it successfully. That does not by itself ensure one payment buys only one application operation: several requests can present the same payment before confirmation, or ask to reuse a confirmed receipt.

The official facilitator deduplicates settlement by the canonical transaction ID, computed from the transaction body. It can resume observation of a known transaction without broadcasting again. The demo's `PaymentOperations` additionally binds that transaction to one route and operation ID and caches the resource body. A retry of that operation gets the same result; reusing the transaction for another operation is rejected. Changing witness encoding cannot create a new transaction identity. The application also remembers successful verification for the exact original payload, requirements and operation. An identical retry reaches the official settlement path directly, where the SDK handles post-broadcast validation and expiry. This avoids treating consumed inputs or an elapsed signing window as grounds to reject an already-submitted payment before its settlement can be checked. Changed bytes, terms or operation IDs do not reuse this verification.

Masumi also needs a logical payment identity. Two different transactions could otherwise lock funds for the same signed quote. The official server stores each issued quote and binds its `termsDigest` to the first transaction that claims it. A second transaction for the same terms is rejected.

These stores are process-local here. Their behavior across retries within a running demo is not a restart or multi-instance guarantee. Production deployments need durable records, atomic claims and retention through transaction expiry plus a confirmation/rollback grace period. Application-level effects need their own durable idempotency strategy.

## Confirmation and an uncertain result

The offer's `extra.confirmationPolicy.l1Confirmations` controls the evidence required before success:

| Level | Required evidence |
|---|---|
| `-1` | The facilitator's own successful broadcast acceptance |
| `0` | Inclusion in a canonical block |
| `1` through `20` | That many newer canonical blocks after inclusion |

An omitted policy defaults to `1`. Greater evidence satisfies a lower threshold. `-1` is disabled by default; enable `ACCEPT_MEMPOOL=true` only to explore it, since mempool acceptance does not guarantee inclusion. `/supported` advertises the available range, while each 402 selects the actual policy. The client must read that policy from the offer.

The facilitator waits at most `CONFIRMATION_TIMEOUT_MS`, 75000 by default, per settlement attempt. With Blockfrost, `awaitConfirmation: false` lets the official scheme own this bounded wait rather than nesting a provider wait inside it. If the evidence is insufficient, it returns `settlement_pending` with the canonical transaction ID. The official core retries settlement **once**, using identical payload and requirements.

If both attempts remain pending, the browser receives HTTP 402 with a failure `PAYMENT-RESPONSE` receipt. It retains the original URL and `PAYMENT-SIGNATURE`, and keeps checking serially, with pauses growing from five to thirty seconds, until the payment settles, expires or is rejected, for up to 20 minutes. Transient transport failures and interrupted resource responses also trigger automatic recovery. If checking pauses (an unexpected answer, or the 20 minutes run out), **Check this payment again** resumes the same request without rebuilding or asking for another signature. An unreadable or mismatched receipt, or a verification rejection, stops automatic checking and preserves the payment for inspection; it is not proof that no payment occurred.

A generic `exact_cardano_settlement_failed` can also mean the provider lost its response after broadcasting. The browser keeps that payment. It permits a fresh attempt only for a matching `exact_cardano_settlement_definitively_rejected` receipt or a matching failure explicitly marked `extra.status: "expired"`. Its four-minute paid-request timeout likewise preserves the payment for checking. The bundled facilitator adds a narrow guard to expired SDK results: a fresh, bounded provider lookup must successfully report the transaction as unknown. A lookup failure or newly observed transaction keeps the receipt pending and lets the next official settlement check decide. This prevents an evidence-provider outage after TTL from being mistaken for proof that no payment landed.

Keep the tab open while checking. Retry state is in browser memory, and the UI blocks switching methods, wallets, confirmation settings or tabs while a payment is in progress or uncertain. The server keeps the chosen confirmation level in the request URL, so changes to its default do not alter an existing retry.

The resource server sizes each facilitator HTTP timeout above the facilitator's advertised wait. It uses at least 120000ms by default, with a 45000ms margin; an external facilitator without `/health` is assumed to use a 75000ms wait. `FACILITATOR_TIMEOUT_MS` can override this if it leaves at least a 15000ms margin. A timeout after submission is an uncertain outcome, not evidence of non-payment.

## Masumi is an escrow lock

An ordinary payment transfers value to the receiving address. Masumi places value in its escrow smart contract (`vested_pay`), with an inline datum: the data attached to the contract output that says who may do what and when. A successful x402 receipt means the **lock settled**, not that the seller received spendable funds.

The official resource-server scheme issues fresh requirements for each new unpaid request. It builds a request commitment, chooses a fresh seller nonce and deadlines, and has the seller sign a digest of those terms (`termsDigest`) with its wallet key, as a COSE signature. The complete issued requirements are stored and reused on the paid retry. Both the buyer and the facilitator validate the signed authorization and the derived deployment address. Masumi requires distinct buyer and seller payout addresses.

The **Masumi agent** tab shows this end to end with a registered agent that runs in `masumi/`. The agent issues the escrow offers and verifies and submits payments with its own built-in facilitator (not the one on port 4022). It does the job and submits the result hash on chain; after the unlock time the seller runs `npm run collect` in `masumi/`. The tab follows the money through each step. See `masumi/README.md` to run and register the agent, and `masumi/docs/FLOWS.md` for every request and transaction. The **Transactions** tab offers only ordinary payments.

## Run and inspect the demo

From the repository root, with Node 22+:

```sh
./setup.sh
# Edit facilitator/.env, server/.env and frontend/.env as described below.
npm run dev
```

Set `BLOCKFROST_PROJECT_ID` in the facilitator, your own `SERVER_CARDANO_ADDRESS` in the server, and `VITE_BLOCKFROST_PROJECT_ID` in the frontend. Both provider IDs must select preprod. The Vite value is public to the browser; use a dedicated demo project. Setup preserves existing `.env` files. All dependencies install from the root lockfile using `npm ci`.

The UI loads `GET /demo/config` before enabling payment. That response contains the supported methods, confirmation range and default. `POST /demo/config` changes only `l1Confirmations`. The default route is `GET /api/message`; Advanced exposes the token route.

| Route | Atomic amount | Method |
|---|---|---|
| `GET /api/message` | `2000000` lovelace | `default` |
| `GET /api/message-usdm` | `100000` token units | `default` |

Start reading the implementation at `server/src/app.ts`, then `frontend/src/x402/flow.ts`. `frontend/src/x402/cip30Signer.ts` contains the browser wallet adapter; `facilitator/src/facilitator.ts` exposes the official scheme over HTTP.

Run `npm run typecheck`, `npm run build`, `npm test`, `npm run test:browser` and `npm run verify:docs`. Browser tests require Playwright Chromium. Automated checks exercise both payment routes through the production CIP-30 signer, HTTP facilitator and Blockfrost adapter using a local provider fixture, including pending recovery, expiry and provider failures. They do not demonstrate a real network settlement; that needs your configured provider and funded preprod wallet.

For errors, read the UI's decoded protocol reason and the server log. A missing facilitator prevents configuration from loading. Stale or preview UTxOs prevent signing. Provider 402/429 responses indicate quota or rate limits. Pending or interrupted paid requests require checking the same payment, not starting a new one.

## Protocol sources

- [x402 v2](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md)
- [HTTP transport v2](https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/http.md)
- [Cardano exact scheme](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_cardano.md)
- [Published Cardano package](https://www.npmjs.com/package/@x402/cardano/v/2.26.0)

This demo uses v2 headers and payloads. Legacy v1 examples using `X-PAYMENT` or `X-PAYMENT-RESPONSE` are not interchangeable with it.
