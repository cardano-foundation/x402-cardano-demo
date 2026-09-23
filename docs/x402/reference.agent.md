# x402 Cardano — Machine Reference

Scope: this preprod demo and official npm artifacts **2.26.0**. Protocol sources are linked under CITATIONS. This reference is checked against installed exports with `npm run verify:docs`; behavioral claims also need the application tests.

## WIRE

All three headers carry base64-encoded JSON. `PAYMENT-SIGNATURE` contains a complete `PaymentPayload`, not a raw cryptographic signature.

| Header | Direction | Type |
|---|---|---|
| `PAYMENT-REQUIRED` | Server → client, HTTP 402 | `PaymentRequired` |
| `PAYMENT-SIGNATURE` | Client → server, paid request | `PaymentPayload` |
| `PAYMENT-RESPONSE` | Server → client, settlement response | `SettleResponse` |

Flow: client signs without broadcast → facilitator verifies → resource handler runs with its response buffered → facilitator broadcasts and checks evidence → server releases response on successful settlement. All Cardano transfer methods use this authorization flow.

## TYPES

| Type | Required fields | Optional fields |
|---|---|---|
| `PaymentRequired` | `x402Version: 2`, `resource`, `accepts: PaymentRequirements[]` | `error`, `extensions` |
| `PaymentRequirements` | `scheme`, `network`, `amount`, `asset`, `payTo`, `maxTimeoutSeconds` | `extra` |
| `PaymentPayload` | `x402Version: 2`, `accepted: PaymentRequirements`, `payload` | `resource`, `extensions` |
| `ResourceInfo` | `url` | `description`, `mimeType`, `serviceName`, `tags`, `iconUrl` |
| `VerifyResponse` | `isValid: boolean` | `invalidReason`, `invalidMessage`, `payer`, `extra`, `extensions` |
| `SettleResponse` | `success: boolean`, `transaction: string`, `network` | `errorReason`, `errorMessage`, `payer`, `amount`, `extra`, `extensions` |
| `SupportedResponse` | `kinds: SupportedKind[]`, `extensions: string[]`, `signers` | — |
| `SupportedKind` | `x402Version`, `scheme`, `network` | `extra` |
| Cardano `payload` | `transaction: string` (base64 fully signed CBOR), `nonce: string` (`txHash#index`, consumed input) | — |

`amount` is a positive canonical decimal string in atomic asset units. `transaction` may be empty in a failure receipt if there is no known transaction ID. HTTP codecs and envelope types belong to `@x402/core`; use their public exports.

## ENDPOINTS

| Method | Path | Meaning |
|---|---|---|
| POST | `/verify` | Read-only payment validation; body `{paymentPayload, paymentRequirements}` |
| POST | `/settle` | Submit once and resume observation by canonical transaction ID; same body shape |
| GET | `/supported` | Supported network, scheme, transfer methods and confirmation range |
| GET | `/health` | Demo-only health and facilitator wait budget |
| GET | `/demo/config` | Demo resource server: available methods, current confirmation default and range |
| POST | `/demo/config` | Demo resource server: accepts only `{l1Confirmations: integer}` |

Protocol-invalid payments are valid `/verify` or `/settle` HTTP responses containing failure results. Transport failure and protocol failure are distinct.

## RULES

| # | Name | Statement |
|---|---|---|
| 1 | Network | Transaction matches the selected network. CIP-34 aliases normalize before matching. |
| 2 | Recipient | Required recipient output exists. |
| 3 | Amount | Recipient output has at least the requested amount; Masumi imposes exact lock values. |
| 4 | Asset | Asset identifier matches the selected requirements. |
| 5 | Nonce | Nonce identifies a consumed, available input before first submission. |
| 6 | Phase-1 | Validate authenticated input values, value conservation and fee floor; unsupported value-moving features require a complete validator. |
| 7 | TTL | Before first submission, expiry is in the future and within `maxTimeoutSeconds`; convert network time to slots correctly. |
| 8 | Minimum UTxO | Recipient output meets the live-parameter minimum when those parameters are available. |
| 9 | Confirmation | Authenticated evidence meets the selected policy before the response is released. |

Masumi additional checks, not extra numbered rules:

- Closed schemas; recomputed input commitment and `termsDigest`; valid seller COSE authorization.
- Independently derived deployment address equals `payTo`; exactly one escrow output; no reference script.
- Valid 19-field V2 inline datum, `FundsLocked`, empty result, zero cooldown timers; signed fields match exactly.
- Buyer controls the nonce input; participant and return-address invariants hold.
- Exact requested asset set and amount; collateral and post-result minimum UTxO hold; TTL respects `payByTime`.
- Nonempty agent identity requires independent registry validation. This demo omits it.
- Issuer preserves each fresh quote and binds its `termsDigest` to the first canonical transaction ID.

The general `script` method binds `payTo` to the declared script but cannot validate arbitrary contract-specific datum meaning. This demo does not offer that method.

## ENUMS

| Item | Values / constraints |
|---|---|
| Scheme | `exact` |
| Networks | `cardano:mainnet`, `cardano:preprod`, `cardano:preview`; demo uses preprod |
| Assets | `lovelace` or `policyId.assetNameHex` |
| Transfer methods | Specification: `default`, `masumi`, `script`; demo: `default`, `masumi` |
| Fees | `areFeesSponsored: false`; payer funds fees and minimum output ADA |
| Confirmation level `-1` | Facilitator's own broadcast acceptance; requires operator opt-in |
| Confirmation level `0` | Canonical block inclusion |
| Confirmation levels `1..20` | That many newer canonical blocks |
| Confirmation default | `1` when omitted |
| Capability range | `SupportedKind.extra.l1Confirmations: {minimum, maximum}` |
| Successful receipt evidence | `extra.status: confirmed` with actual depth, or `mempool` with `confirmations: -1` |
| Pending receipt | `success: false`, `errorReason: settlement_pending`, canonical `transaction`, `extra.status: pending` |

Canonical network names use CAIP-2 syntax; `cardano` is not a CASA-registered namespace. Preprod and preview both use CIP-30 network ID `0`.

## RETRY INVARIANTS

- The browser never broadcasts; the facilitator signs nothing.
- A settlement claim uses the canonical transaction ID, not signed CBOR encoding.
- `@x402/core` retries `settlement_pending` once with identical payload and requirements.
- A browser-facing pending/unknown result retains the original URL and `PAYMENT-SIGNATURE`; checking it never builds another transaction. The UI requests three automatic serial checks, five seconds apart, for pending or transient failures. Exhaustion pauses for manual recovery; invalid/mismatched receipts and verification rejections require inspection.
- A timeout, transport error, or generic `exact_cardano_settlement_failed` after submission does not establish non-payment. Only a matching definitive-rejection or explicitly expired receipt releases an uncertain payment. The bundled facilitator confirms any SDK expiry result with a successful fresh evidence lookup returning unknown; lookup errors or observed transactions remain pending. The extra lookup is capped at 15 seconds.
- Application handlers may run on each paid retry. This demo caches the body and binds one transaction to one route and request ID. A successful verification is reused only for the identical payload, requirements and operation; the official settlement path still performs post-broadcast checks. Invalid verification results never reserve an operation. This lets previously submitted payments reach confirmation or explicit expiry instead of failing fresh TTL/unspent-input validation.
- Masumi requires the originally issued quote; unknown or altered terms are rejected before settlement. A second transaction cannot claim the same terms.
- Successful Masumi settlement means escrow lock, not seller payout. No release/refund/dispute workflow is implemented here; stock Masumi Payment Service lifecycle signatures are incompatible with x402 `termsDigest` authorization.
- Browser retry state, application operation records, Masumi quote records and facilitator settlement records are process-local. No restart or distributed persistence guarantee is provided.

## ERRORS

Complete `ERR_*` string inventory exported by the pinned `@x402/cardano` release. The verifier compares identifiers and wire strings to runtime exports instead of assuming a permanent count. Descriptions summarize the error family; protocol response context supplies details.

| Identifier | Wire string | Meaning |
|---|---|---|
| `ERR_AMOUNT_INSUFFICIENT` | `invalid_exact_cardano_payload_amount_insufficient` | right asset, not enough of it (rule 3) |
| `ERR_ASSET_MISMATCH` | `invalid_exact_cardano_payload_asset_mismatch` | output pays a different asset (rule 4) |
| `ERR_CHAIN_LOOKUP_FAILED` | `exact_cardano_facilitator_chain_lookup_failed` | on-chain lookup needed for verification failed |
| `ERR_DUPLICATE_SETTLEMENT` | `duplicate_settlement` | Transaction or logical payment is already claimed in a conflicting operation. |
| `ERR_EVIDENCE_UNAVAILABLE` | `exact_cardano_facilitator_evidence_unavailable` | Required authenticated settlement evidence cannot be obtained. |
| `ERR_FEE_BELOW_MINIMUM` | `invalid_exact_cardano_payload_fee_below_minimum` | Transaction fee is below the live-parameter floor. |
| `ERR_INPUT_NOT_AVAILABLE` | `invalid_exact_cardano_payload_input_not_available` | an input is spent; tx would be rejected at submission |
| `ERR_INPUT_VALUE_UNAVAILABLE` | `exact_cardano_facilitator_input_value_unavailable` | Authenticated values of transaction inputs are unavailable. |
| `ERR_INVALID_PAYLOAD` | `invalid_exact_cardano_payload` | payload missing required fields |
| `ERR_INVALID_SIGNATURE` | `invalid_exact_cardano_payload_invalid_signature` | a vkey witness signature is invalid over the body |
| `ERR_MASUMI_AGENT_IDENTIFIER` | `invalid_exact_cardano_requirements_masumi_agent_identifier` | `agentIdentifier` lacks the V2 registry policy id |
| `ERR_MASUMI_ASSET` | `invalid_exact_cardano_payload_masumi_asset` | escrow output lacks the requested asset/amount |
| `ERR_MASUMI_COLLATERAL` | `invalid_exact_cardano_payload_masumi_collateral` | `collateral_return_lovelace` violates floor/ceiling rules |
| `ERR_MASUMI_COMMITMENT` | `invalid_exact_cardano_requirements_masumi_commitment` | a commitment digest does not recompute |
| `ERR_MASUMI_CONTRACT_MISMATCH` | `invalid_exact_cardano_payload_masumi_contract_mismatch` | masumi `payTo` is not the known escrow address |
| `ERR_MASUMI_DATUM_INVALID` | `invalid_exact_cardano_payload_masumi_datum_invalid` | lock datum structurally invalid or violates invariants |
| `ERR_MASUMI_DATUM_MISMATCH` | `invalid_exact_cardano_payload_masumi_datum_mismatch` | lock datum does not match the requirements' extra |
| `ERR_MASUMI_DATUM_MISSING` | `invalid_exact_cardano_payload_masumi_datum_missing` | escrow output carries no inline datum |
| `ERR_MASUMI_DEADLINE` | `invalid_exact_cardano_payload_masumi_deadline` | validity upper bound not on/before `pay_by_time` |
| `ERR_MASUMI_DEPLOYMENT` | `invalid_exact_cardano_requirements_masumi_deployment` | derived deployment escrow address ≠ `payTo` |
| `ERR_MASUMI_ESCROW_OUTPUT_COUNT` | `invalid_exact_cardano_payload_masumi_escrow_output_count` | more than one output at the escrow address |
| `ERR_MASUMI_IDENTIFIER` | `invalid_exact_cardano_requirements_masumi_identifier` | `blockchainIdentifier` does not decode to the reconstruction |
| `ERR_MASUMI_MIN_UTXO` | `invalid_exact_cardano_payload_masumi_min_utxo` | escrow output below post-result min-UTxO |
| `ERR_MASUMI_REFERENCE_SCRIPT` | `invalid_exact_cardano_payload_masumi_reference_script` | escrow output carries a reference script |
| `ERR_MASUMI_SCHEMA` | `invalid_exact_cardano_requirements_masumi_schema` | masumi `extra` violates the closed-object schema |
| `ERR_MASUMI_SELLER_SIGNATURE` | `invalid_exact_cardano_requirements_masumi_seller_signature` | seller COSE authorization over `termsDigest` fails |
| `ERR_MASUMI_TERMS_MISMATCH` | `masumi_terms_mismatch` | retry altered the issued requirements |
| `ERR_MASUMI_TERMS_UNKNOWN` | `masumi_terms_unknown` | retry quotes terms this server never issued |
| `ERR_MIN_UTXO_INSUFFICIENT` | `invalid_exact_cardano_payload_min_utxo_insufficient` | recipient output below protocol min-UTxO (rule 8) |
| `ERR_NETWORK_ID_MISMATCH` | `invalid_exact_cardano_payload_network_id_mismatch` | tx targets a different Cardano network (rule 1) |
| `ERR_NETWORK_MISMATCH` | `network_mismatch` | declared and accepted networks differ |
| `ERR_NONCE_INVALID` | `invalid_exact_cardano_payload_nonce_invalid` | nonce UTxO ref missing or malformed |
| `ERR_NONCE_NOT_IN_INPUTS` | `invalid_exact_cardano_payload_nonce_not_in_inputs` | nonce is not one of the tx inputs (rule 5) |
| `ERR_NONCE_NOT_ON_CHAIN` | `invalid_exact_cardano_payload_nonce_not_on_chain` | nonce UTxO already spent or never existed |
| `ERR_POLICY_INVALID` | `invalid_exact_cardano_requirements_policy` | Confirmation policy is malformed or unsupported. |
| `ERR_RECIPIENT_MISMATCH` | `invalid_exact_cardano_payload_recipient_mismatch` | no output goes to `payTo` (rule 2) |
| `ERR_REQUIREMENTS_INVALID` | `invalid_exact_cardano_requirements` | canonical requirements malformed |
| `ERR_SCRIPT_ADDRESS_MISMATCH` | `invalid_exact_cardano_payload_script_address_mismatch` | script method selected but reconstruction failed |
| `ERR_SETTLEMENT_DEFINITIVELY_REJECTED` | `exact_cardano_settlement_definitively_rejected` | node rejected the tx before ledger acceptance |
| `ERR_SETTLEMENT_FAILED` | `exact_cardano_settlement_failed` | Settlement failed; inspect the response context for the cause. |
| `ERR_SETTLEMENT_NOT_CONFIRMED` | `exact_cardano_settlement_not_confirmed` | Requested settlement evidence is not accepted under facilitator policy. |
| `ERR_SETTLEMENT_PENDING` | `settlement_pending` | Transaction known; required confirmation evidence is not yet reached. Resume the same payment. |
| `ERR_TRANSACTION_DECODE_FAILED` | `invalid_exact_cardano_payload_transaction_decode_failed` | tx could not be CBOR decoded |
| `ERR_TRANSACTION_PHASE1_INVALID` | `invalid_exact_cardano_payload_phase1_invalid` | Transaction violates phase-1 checks or needs unsupported ledger validation. |
| `ERR_TRANSACTION_PHASE2_INVALID` | `invalid_exact_cardano_payload_phase2_invalid` | failed-script tx; consumes collateral, pays nothing |
| `ERR_TRANSACTION_UNSIGNED` | `invalid_exact_cardano_payload_unsigned` | no vkey/bootstrap witnesses present |
| `ERR_TTL_EXPIRED` | `invalid_exact_cardano_payload_ttl_expired` | TTL already passed (rule 7) |
| `ERR_TTL_TOO_FAR` | `invalid_exact_cardano_payload_ttl_too_far` | TTL later than now + `maxTimeoutSeconds` (rule 7) |
| `ERR_UNSUPPORTED_SCHEME` | `unsupported_scheme` | scheme is not `exact` |
| `ERR_VALIDITY_NOT_YET_VALID` | `invalid_exact_cardano_payload_not_yet_valid` | lower validity bound is in the future |
| `ERR_VALUE_NOT_CONSERVED` | `invalid_exact_cardano_payload_value_not_conserved` | Input values do not balance outputs and fee. |

## REPO

| Route | Atomic amount | Asset | Method |
|---|---|---|---|
| `GET /api/message` | `2000000` | `lovelace` | `default` |
| `GET /api/message-usdm` | `100000` | Native token | `default` |
| `GET /api/message-masumi` | `5000000` | `lovelace` | `masumi` |
| `GET /api/message-masumi-usdm` | `250000` | Native token | `masumi` |

Default native asset, `USDM_PREPROD_ASSET`:
`e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9.0014df10745553444d`.

| Component | Port | Configuration |
|---|---|---|
| Frontend | 5173 | `VITE_BLOCKFROST_PROJECT_ID`, `VITE_SERVER_URL` |
| Server | 4021 | `SERVER_CARDANO_ADDRESS`, `FACILITATOR_URL`, optional `MASUMI_SELLER_MNEMONIC`, `USDM_ASSET`, `L1_CONFIRMATIONS`, `FACILITATOR_TIMEOUT_MS` |
| Facilitator | 4022 | `BLOCKFROST_PROJECT_ID`, optional `BLOCKFROST_BASE_URL`, `ACCEPT_MEMPOOL`, `CONFIRMATION_TIMEOUT_MS` |

- Node 22+; one root npm workspace and `package-lock.json`; `./setup.sh` runs `npm ci` and copies only missing `.env` files.
- `npm run dev` starts all services; server waits briefly for facilitator readiness.
- Browser key is public; use a dedicated preprod provider project. Replace the example receiving address.
- Default facilitator wait: 75000ms per call. Provider signer uses `awaitConfirmation: false`.
- Resource server default HTTP timeout: `max(120000, wait + 45000)`; fallback wait 75000ms. Override must leave at least 15000ms margin.
- Blank optional seller mnemonic selects a public test phrase; it does not need funds to authorize quotes.
- Verification: `npm run typecheck`, `npm run build`, `npm test`, `npm run test:browser`, `npm run verify:docs`. Browser tests require Playwright Chromium; real preprod settlement needs separate manual verification.

## CITATIONS

| Source | Link |
|---|---|
| Protocol v2 | [x402 specification](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md) |
| HTTP v2 | [HTTP transport](https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/http.md) |
| Cardano | [Exact scheme](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_cardano.md) |
| Published SDK | [@x402/cardano 2.26.0](https://www.npmjs.com/package/@x402/cardano/v/2.26.0) |
| Demo server | [app.ts](../../server/src/app.ts), [paymentOperations.ts](../../server/src/paymentOperations.ts) |
| Demo browser | [flow.ts](../../frontend/src/x402/flow.ts), [cip30Signer.ts](../../frontend/src/x402/cip30Signer.ts) |
| Demo facilitator | [facilitator.ts](../../facilitator/src/facilitator.ts) |
