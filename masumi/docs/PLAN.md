# Masumi End-to-End Demo — Implementation Plan (rev. 4)

**Goal.** A standalone `masumi/` demo with a dummy agent that is:
- registered in the Masumi registry on preprod;
- automatically listed on Sokosumi preprod;
- hireable through **two** paths into the same Masumi V2 escrow:
  1. the **standard Masumi path**: MIP-003 `POST /start_job`, the way Sokosumi, Soko Bot or any Masumi Payment Service buyer hires;
  2. the **x402 path**, driven by the official `@x402/cardano` library from a small CIP-30 UI.

For both paths the agent submits the result hash on-chain, and the seller collects after `unlockTime`. The price is **Masumi's preprod tUSDM**, unit `16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d`.

This is **not** the library's `USDM_PREPROD_ASSET` (`e675b46e…`), which is a different token that Sokosumi does not price in. The unit is always set explicitly. Metadata and Blockfrost use the concatenated form; x402 `asset` uses the dotted `policy.name` form. Comparisons normalize by stripping the `.`.

**Scope.**
- Everything lives in `masumi/`, with its own `package.json`. It is not a root workspace (the root lists `facilitator`, `server` and `frontend` explicitly).
- Preprod only.
- The escrow lifecycle covered is lock → SubmitResult → Withdraw.
- No Masumi Payment Service is run on the seller side.

**Architecture.** There is one Node process (the agent). It contains:
- the MIP-003 API;
- the x402 gate with an in-process facilitator;
- a seller-side escrow signer for the standard path;
- one escrow watcher shared by both paths;
- the chain transactions (Evolution SDK).

Around it:
- **UI:** Vite + React.
- **CLI scripts:** `register`, `deregister`, `collect`, and three checks (`check-quote`, `check-registry`, `check-purchase`).

## Global constraints
- No file outside `masumi/` is created or modified. Check: `git status --porcelain` shows only `?? masumi/` beyond the pre-existing `?? docs/plans/` and `?? python/`.
- Pinned dependencies:
  - `@x402/cardano`, `@x402/core` and `@x402/express` at `2.26.0`;
  - `@evolution-sdk/evolution@0.5.13`;
  - `lz-string@1.5.0` and `canonical-json@0.2.0`, the same versions the Payment Service uses for the standard-path identifier;
  - dev only: `@meshsdk/core-cst@1.9.0-beta.90`, the exact version the Payment Service root pins, used for `checkSignature` in the verifier test.
- No secrets are committed.
- Masumi blueprints are vendored from `masumi-payment-service@69297f3` (MIT, © NMKR) with a notice.

---

## Summary

**The Sokosumi facts behind this revision** come from source: `sokosumi@8327114` (today) and `masumi-payment-service@69297f3`.

- **Listing** is automatic on preprod with no whitelist in code (`sokosumi/apps/core/src/helpers/agent.ts:292-408`). The conditions:
  - the registry health check reports the agent **Online** (`GET {api_base_url}/availability`, which needs a public URL);
  - it is a Standard agent (metadata `type` absent);
  - it has one V2 source `Cardano / Preprod / Web3CardanoV2` whose address is the escrow;
  - it has **Fixed** pricing in a unit Sokosumi has credits for, which is tUSDM.
- **The Sokosumi app has no Hire button anymore** (ADR-0006 and 0024: the catalog is browse-only). Hires come from **Soko Bot**, **Coworker** or the Core API `POST /v1/agents/{id}/jobs`. All of them call our MIP-003 API:
  1. `GET /input_schema`;
  2. `POST /start_job {identifier_from_purchaser (20 hex), input_data}`;
  3. Sokosumi's Payment Service `POST /purchase` locks the funds;
  4. it polls `GET /status`.
- **Purchase validation** (`purchases/shared.ts:53-280`) checks:
  - that our `blockchainIdentifier` carries a CIP-8 signature over `sha256(canonical-json(payload))`;
  - that the signing key's hash equals `sellerVKey`, which must be the payment key of the address **holding the registry NFT**;
  - that `agentIdentifier` resolves to on-chain metadata whose source address is the escrow address and whose price equals the paid `Amounts`.

  A research spike reproduced this recipe with the library's own `toMasumiSellerSigner`, and Mesh `checkSignature` accepted the result. So no Payment Service is needed on our side.
- **x402 quotes can't double as MIP-003 responses.** The library signs a domain-separated `termsDigest`, so the paths sign separately. They share the seller key, the escrow address, the datum shape and the watcher.
- **Buyer-side automation:** if `result_hash` is still empty 10 min after `submitResultTime`, the buyer node auto-withdraws a refund (`automatic-decisions/service.ts:110-130`). We submit results right after the lock is seen, so this deadline has large headroom.

**Registry decision (unchanged).** A direct mint of the permissionless V2 registry NFT (policy `67ab0c92…bd0b`), sent to the **exact** seller address that signs the terms.

**Route decision.** The MIP-003 `POST /start_job` is the standard path, because Sokosumi calls exactly that URL and expects a 200 with terms. The x402 path is `POST /x402/start_job`, whose 402 is the payment request. Both routes sit under `api_base_url`.

## Diagram — both hire paths share one escrow lifecycle

```mermaid
sequenceDiagram
  autonumber
  actor Op as Operator (seller)
  participant S as Sokosumi / Soko Bot + its Payment Service
  participant UI as x402 UI (browser, CIP-30)
  participant A as Agent (MIP-003 + x402 + watcher)
  participant BF as Blockfrost (preprod)

  Op->>BF: npm run register — mint registry NFT → seller address (tUSDM Fixed price, source = escrow)
  Note over S,A: registry health check GET /availability → Online → Sokosumi lists agent

  rect rgb(235,242,255)
  Note over S,A: Standard Masumi path
  S->>A: GET /input_schema, POST /start_job {identifier_from_purchaser, input_data}
  A-->>S: 200 {id, blockchainIdentifier (seller-signed), times, agentIdentifier, sellerVKey, input_hash}
  S->>BF: Payment Service POST /purchase → lock tUSDM in escrow (datum seller_nonce = ours)
  end

  rect rgb(235,255,240)
  Note over UI,A: x402 path
  UI->>A: POST /x402/start_job {identifier_from_purchaser, input_data}
  A-->>UI: 402 (masumi extra, agentIdentifier, commitment = input)
  UI->>BF: registry-claim check; build lock; wallet.signTx
  UI->>A: POST /x402/start_job + PAYMENT-SIGNATURE
  A->>BF: in-process facilitator verify + settle (broadcast lock)
  A-->>UI: 200 MIP-003 body (job id)
  end

  loop watcher (10 s) until an exactly matching lock or submitResultTime − margin
    A->>BF: escrow UTxOs → x402: the verified lock txHash; standard: datum == expected datum from the job's signed terms (buyer fields free) ∧ tUSDM ≥ price
  end
  A->>A: dummy task → result, result_hash (MIP-004)
  A->>BF: SubmitResult (evaluated; redeemer 5; state → ResultSubmitted)
  S->>A: GET /status?job_id → completed + result
  UI->>A: GET /status?job_id → completed + result
  Note over Op,BF: after unlockTime
  Op->>BF: npm run collect (agent stopped) → Withdraw (evaluated; redeemer 0) → seller
```

## Change map

```
masumi/                                   all new; nothing outside touched
  package.json                  +45   standalone deps + scripts
  tsconfig.json  vite.config.ts  index.html  .gitignore  .env.example
  contracts/ registry-v2.plutus.json  payment-v2.plutus.json  NOTICE.md
  src/
    config.ts                   +45   env, constants (tUSDM unit, escrow), seller signer + exact seller address
    masumi.ts                   +90   pure: registry asset name, V2 metadata, MIP-004 hashes, standard-path identifier
                                      (canonical-json payload → CIP-8 sign → LZString), SubmitResult datum
    registry.ts                 +50   MasumiRegistryValidator over Blockfrost (agent facilitator + UI); unit normalization
    lockMatch.ts                +50   ⚠ funds: expected-datum check for a candidate escrow UTxO (both paths)
    chain.ts                    +170  ⚠ funds: Evolution client, scripts, serial tx queue, register/deregister/submitResult/withdraw, escrow scan
    agent.ts                    +190  Express: MIP-003 routes (standard), x402 route, job store, watcher
    scripts/register.ts  deregister.ts  collect.ts   +70
    scripts/check.ts            +70   check-quote (x402), check-registry (live), check-purchase (standard path vs Payment Service rules)
    ui/main.tsx  App.tsx  cip30Signer.ts  styles.css   +310
  test/
    masumi.test.ts              +120  blueprint digest, script parity, asset name, metadata, hashes, datum transition
    standard-path.test.ts       +120  HTTP start_job response → Sokosumi schema → Sokosumi forwarding → verbatim port of Payment Service
                                      payload builder + checks → Mesh checkSignature (beta.90); negative cases
    lockMatch.test.ts           +80   one spoofed datum per seller-determined field is rejected; the genuine lock is accepted
    vendor/paymentServiceVerifier.ts +60  verbatim port (MIT) of buildSignedBlockchainIdentifierPayload + purchase checks, with source line refs
    registry.test.ts            +50   validator accept / reject cases
  README.md                     +240  run / register / Sokosumi listing & hire / x402 UI / collect / deregister / troubleshoot
  docs/DEVELOPER.md             +350  blueprint guide: architecture, Masumi concepts, both paths, invariants, adapting, testing, pitfalls
  docs/PLAN.md                  this file
```

`⚠` sits only on `chain.ts` (funds). `agent.ts` `POST /start_job` becomes a **public API** that third parties (Sokosumi) depend on. It is new, so nothing existing breaks, but its response shape is a contract.

## Risk table

| # | Change | Risk | Why | Review this |
|---|---|---|---|---|
| 1 | SubmitResult tx | High | The continuing datum changes **only** fields 11, 16 and 18. Also required: seller cooldown ≥ slot-aligned upper + 420000, one script output with value ≥ input, finite lower and upper bounds, upper < `submit_result_time`, the seller as signer, collateral. It must handle **both** datum producers: Payment Service locks have a non-zero `collateral_return_lovelace` and possibly a `buyer_return_address`. Values are read from the UTxO and never assumed. | Line-by-line. `complexity-specialist` first (Task 3) |
| 2 | Withdraw tx | High | Needs a finite upper bound (`vested_pay.ak:139`) and a lower bound ≥ `unlock_time` (slot-rounded). No script output may carry the same `reference_signature`. The seller signs. A buyer output tagged `OutputReference(txHash, idx)` must carry ≥ `collateral_return_lovelace` (> 0 on Payment Service locks), sent to `buyer_return_address` or else `buyer`, matching the full address. `seller_return_address` is None on both paths. | Line-by-line |
| 3 | Standard-path signature payload | High | It must byte-match the Payment Service's `canonical-json` payload: `RequestedFunds:null`, `sellerReturnAddress:null`, `supportedPaymentSourceIndex:0` as a number, ms-strings for times, `sellerAddress` = the NFT holder's bech32 **exactly**, and no `undefined` values. Any drift means Sokosumi's `/purchase` rejects. Guarded by `standard-path.test.ts` with Mesh `checkSignature`. | Line-by-line + test |
| 4 | Seller address identity | High | The NFT holder address, the signing key and the datum `seller` must all be the same key credential, and the bech32 must be identical (stake part included). `register` sends the NFT to `toMasumiSellerSigner(...).sellerAddress`. `check-registry` asserts the holder equals it. | Read |
| 5 | x402 settle ordering | High | `@x402/express` runs the handler before settlement. The handler does no chain work, and the watcher drives execution. | Read |
| 6 | Registry-claim validator | High | The library rejects an `agentIdentifier` without `validateRegistryClaim` and `resource`. It is wired in the UI and the facilitator. The x402 resource is `${AGENT_PUBLIC_URL}/x402/start_job`. | Line-by-line |
| 7 | Escrow script parity | High | The blueprint digest and script-hash tests guard it. | Read tests |
| 8 | Lock matching (`lockMatch.ts`) | High | The nonce is public, so a matcher that checks only the nonce, state and value accepts hostile locks. A far-future `seller_cooldown_time` blocks SubmitResult and hands the buyer a refund. A far-future `unlock_time` freezes our payout. A `collateral_return_lovelace` above the UTxO's lovelace makes the script fail. A spoof can also shadow the real lock.<br><br>So the matcher rebuilds the **expected datum** from the job's signed terms and requires equality on every field the seller sets: `seller` (exact address), `seller_return_address` None, `reference_key`/`reference_signature` ours, `seller_nonce`, `buyer_nonce` = `identifierFromPurchaser` (standard) or the x402 buyer nonce, `agent_identifier`, `input_hash`, all four times, both cooldowns 0, empty `result_hash`, state 0.<br><br>Only `buyer`, `buyer_return_address` and `collateral_return_lovelace` are free. The latter must be ≤ the UTxO's lovelace, and the tUSDM quantity must be ≥ the price. x402 jobs additionally require the verified lock tx hash. All non-matching candidates are ignored, and a match is never "first wins": the whole predicate must hold. | Line-by-line + tests |
| 9 | Deadlines | Medium | Standard path: payBy +15 min, submitResult +40 min, unlock +60 min, dispute +80 min. All five rules in `purchases/shared.ts:53-68` hold if `/purchase` is called within 25 min of `start_job`. The watcher keeps looking until `submitResultTime − 5 min`, not `payByTime`, so a lock that was submitted before `payByTime` but confirmed later is still served. The x402 path uses library defaults. Collect: about 40 min after an x402 purchase, and ≥ 60 min after a standard `start_job`. | Read |
| 10 | Pre-submit evaluation, UTxO contention | Medium | Every script tx is evaluated before submit. There is one serial queue. The README says to stop the agent before `collect`. The NFT UTxO is never selected. | Read |
| 11 | Registry metadata and unit | High | Strict schema, `metadata_version: 2`, `type` absent (Standard), a single source, Fixed **Masumi tUSDM** in concatenated form, 64-byte strings. It must parse under **both** the registry-service schema and the Payment Service `metadataSchema` (`registry/wallet/index.ts:22-107`: `api_base_url`, `name`, `author.name` required). A wrong unit or token means either Sokosumi's price check or our own x402 registry check refuses every purchase. | Read |
| 12 | Public URL / Online status | Medium | The health check rejects localhost and private IPs, and a quick-tunnel URL changes on restart. That stales `api_base_url`: the agent goes Offline and Sokosumi hides it. The README recommends a stable (named) tunnel. | Skim |
| 13 | UI, CLIs, README | Low | Glue. | Skim |

## Acceptance criteria

**Verified by me (no funds needed)**
- [ ] **A1 isolation.** Only `?? masumi/` is new in `git status`.
- [ ] **A2 build.** `npm install && npm run typecheck && npm test && npm run build` exits 0 in `masumi/`, and also on a copy outside the repo.
- [ ] **A3 parity.** These tests pass:
  - `vendored payment blueprint digest matches MASUMI_BLUEPRINT_DIGEST`
  - `escrow script hash matches @x402/cardano deployment`
  - `registry policy id matches MASUMI_REGISTRY_POLICY_ID`
- [ ] **A4 metadata.** Test `registry metadata is a Sokosumi-listable V2 entry` passes:
  - Standard, with one `Web3CardanoV2` preprod escrow source;
  - Fixed at `16a55b2a…0014df10745553444d` (concatenated, no `.`);
  - all strings ≤ 64 bytes;
  - it parses under ports of both the registry-service and Payment Service metadata schemas.
- [ ] **A5 datum transition.** Test `submitResult datum changes only result_hash, seller cooldown, state` passes. It runs for a library-built lock **and** a Payment-Service-shaped lock (non-zero collateral return, a buyer return address).
- [ ] **A5b registry validator.** `registry.test.ts` passes, including a tUSDM claim where the metadata unit is concatenated and the x402 asset is dotted (accept), and the library's `e675…` token (reject).
- [ ] **A5c lock matching.** `lockMatch.test.ts` passes:
  - the genuine lock is accepted;
  - it rejects a lock where any single seller-determined field differs, underpayment, `collateral_return_lovelace` > lovelace, and the library's `e675…` token;
  - a spoof and a genuine lock in the same scan resolve to the genuine one.
- [ ] **A6 standard path (non-circular).** Test `start_job response passes Payment Service purchase validation` passes. It uses **only the HTTP response body** from the agent's `POST /start_job`, never `standardTerms` internals, and replays what really happens:
  1. parse it with a port of Sokosumi's `startPaidJobResponseSchema` (`start_job.schema.ts:20-92`);
  2. apply Sokosumi's forwarding (`job.ts:650-790`): resolved index 0, times via `String(new Date(n).getTime())`, `inputHash` = `input_hash`;
  3. rebuild the payload with a **verbatim port** of `buildSignedBlockchainIdentifierPayload` and the `resolvePurchaseCreationContext` mapping, with `sellerAddress` from a stubbed NFT-holder lookup and `sellerReturnAddress` null;
  4. decode the LZString identifier and check each segment;
  5. check that the COSE key hash equals `sellerVKey`;
  6. run `checkSignature` from `@meshsdk/core-cst@1.9.0-beta.90`;
  7. check the timing rules from `shared.ts:53-68`.

  Negative cases must **fail**:
  - the signer omits `supportedPaymentSourceIndex`;
  - it signs `sellerReturnAddress` ≠ null;
  - it signs a different `sellerAddress` (e.g. without the stake part);
  - a wrong `identifierFromPurchaser` echo.
- [ ] **A7 local API.** With `npm run dev`:
  - `/availability` returns `{status:"available", type:"masumi-agent", agentIdentifier}`.
  - `/input_schema` returns a valid schema.
  - `POST /start_job` returns 200 with all Sokosumi-required fields (`start_job.schema.ts:20-92`).
  - `POST /x402/start_job` returns 402 with masumi extra and `agentIdentifier`.
  - `npm run check-quote` and `npm run check-purchase` pass against the running agent. `check-purchase` runs the A6 verifier pipeline on a live response.

**Live preprod (needs funded wallets, a public URL, a tUSDM-holding buyer; run by me only if you provide them, otherwise reported unverified)**
- [ ] **A8 registration.** `npm run register` prints a tx hash and `MASUMI_AGENT_IDENTIFIER`, and `npm run check-registry` passes (metadata + holder = seller address).
- [ ] **A9 Sokosumi listing.** The agent appears at `preprod.sokosumi.com/agents` (catalog; needs a Sokosumi account with a seat). Unverifiable parts: Sokosumi's `SHOW_AGENTS_BY_DEFAULT` and its tUSDM credit rows.
- [ ] **A10 Sokosumi hire.** A job started via Soko Bot or the Sokosumi API reaches `completed` with the dummy result. The agent logs the SubmitResult tx.
- [ ] **A11 x402 hire.** In the UI, a funded non-seller wallet holding **Masumi** tUSDM (`16a55b2a…`) completes a job (lock tx + SubmitResult tx + result shown). Masumi's faucet `dispenser.masumi.network` says it dispenses "ADA and USDM", but it doesn't say which policy. The README points buyers to it and tells them to confirm the policy `16a55b2a…` in their wallet.
- [ ] **A12 collect.** After `unlockTime`, `npm run collect` withdraws both escrows to the seller.
- [ ] **A14 developer docs.** `docs/DEVELOPER.md` covers the eight sections of Task 7b. Every source reference in it resolves to a real file (spot-checked in review), and every exported function in `src/` has TSDoc.
- [ ] **A13 docs.** The README covers all of the above plus troubleshooting and limits.

---

### Task 1: The standalone package installs with no effect outside `masumi/` (check: A1)
- Create `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `.gitignore` and `.env.example`.
- Vendor the blueprints and the notice.
- Scripts: `dev`, `register`, `deregister`, `collect`, `check-quote`, `check-registry`, `check-purchase`, `test`, `typecheck`, `build`.

### Task 2: Pure helpers, the standard-path identifier and script parity are correct (check: A3–A6 tests; tests written first)
`masumi.ts`:
- `registryAssetName`.
- `registryMetadata`: Standard, one source `{chain:"Cardano", network:"Preprod", settlement:{paymentSourceType:"Web3CardanoV2", address: escrow}, pricing:{pricingType:"Fixed", fixed:[{asset: tUSDM unit, amount}]}}`, `api_base_url`, `name`, `description`, `author`, `tags`, `image`, `metadata_version: 2`, with chunking.
- `inputHash` (MIP-004: `sha256(id + ";" + JCS(input_data))`) and `resultHash`.
- `standardTerms({ id, input, now, signer })`, following Payment Service `payments/index.ts:300-336`:
  - generates the seller nonce;
  - builds the canonical-json payload;
  - calls `signTerms(sellerAddress, sha256(payload))` for the COSE key and signature;
  - builds the LZString identifier;
  - returns the MIP-003 response, including `sellerVKey`, `paymentSourceType:"Web3CardanoV2"` and `supportedPaymentSourceIndex:0`.
- `submitResultDatum`.

`registry.ts`: the validator. It compares by payment key credential and checks price (unit normalized), network, escrow source and `api_base_url`.

`lockMatch.ts`: `matchesJob(utxo, job)` implements Risk row 8. It is pure and exhaustively tested (A5c).

`test/vendor/paymentServiceVerifier.ts`: a verbatim port (MIT) of the Payment Service payload builder and purchase checks, with source line references. It is used only by tests and `check-purchase`, never by `standardTerms`.

### Task 3: The seller-side transactions are specified before coding (check: `complexity-specialist` returns an approved tx spec)
Send `complexity-specialist`:
- this plan;
- `vested_pay.ak` lines 116–347 and 643–700;
- the Masumi submit/withdraw examples;
- Payment Service `contract-generator.ts:193-` and `batch-payments/service.ts:288-305, 1020-1090` (their lock shape);
- the Evolution API;
- the constraints in Risk rows 1–2.

Bounded question: *the exact inputs, outputs, validity, signers, collateral and min-UTxO for SubmitResult and Withdraw on locks from both producers, including a tUSDM value*.

### Task 4: The seller can register, submit and collect (check: typecheck; A8, A12 when funded)
- `chain.ts` with `register`, `deregister`, `submitResult`, `collectAll` and `scanEscrow(sellerKeyHash)`.
- The serial queue, pre-submit evaluation and NFT UTxO exclusion.
- `register` sends the NFT to the exact signer address and prints the id.

### Task 5: The agent serves both paths (check: A7)
`agent.ts`:
- **MIP-003 routes:** `GET /availability`, `GET /input_schema` (one string field `text`), `POST /start_job` (standard: validate the body, then `standardTerms`, then store the job `awaiting_payment`), `GET /status?job_id`.
- **x402 route:** `POST /x402/start_job`, x402-gated.
  - The in-process facilitator runs with `validateRegistryClaim`.
  - `commitment` = `{identifier_from_purchaser, input_data}`.
  - The handler reads the input from `accepted.extra.inputCommitment`, stores the job under `terms.sellerNonce`, returns the MIP-003 body, and does no chain work.
  - `GET /jobs/by-tx/:hash` serves the UI after a settle timeout.
- **Watcher** (10 s): scans the escrow once per tick. For each waiting job it looks for a UTxO where `lockMatch.matchesJob` holds (x402 jobs also by tx hash). A match runs the task, then `submitResult`, then marks the job `completed`. If `submitResultTime − 5 min` passes without a match, the job becomes `failed`. Non-matching UTxOs are logged once and ignored.
- Jobs are in memory, and `/status` follows the MIP-003 states.

### Task 6: A user can hire via x402 from the browser (check: `npm run build`; A11 when funded)
- `cip30Signer.ts`: validate extra, then verify the authorization (registry claim + resource), then the commitment echo check, then `buildMasumiLock` (tUSDM), then `withCip30` sign. It refuses when the buyer equals the seller.
- `App.tsx`:
  - agent card (name, id, price in tUSDM, Sokosumi link);
  - input, then pay;
  - timeline;
  - unlock countdown;
  - a panel "hire via Sokosumi instead" pointing at Soko Bot.

### Task 7: The README lets a new reader run, register, list, hire and collect (check: A13)
Sections:
- overview, with the diagram;
- prerequisites (Node 22, Blockfrost key, tADA from the faucet, tUSDM for buyers, two wallets);
- `.env`;
- a stable public URL, with a named-tunnel recommendation;
- register;
- run;
- Sokosumi (how listing happens, where to find it, hiring via Soko Bot or the API, what "Online" requires);
- the x402 UI;
- the timings table;
- collect (stop the agent first);
- deregister;
- troubleshooting (Offline, not listed, `/purchase` signature rejects, refund race);
- limits.

### Task 7b: Another team can use the demo as a blueprint (check: A14)
`docs/DEVELOPER.md` is the builder's guide; the README stays the operator's guide. It covers:
1. **Architecture:** module map, the dependency direction (`masumi.ts`, `lockMatch.ts` and `registry.ts` are pure or IO-light; `chain.ts` and `agent.ts` do IO), and both hire flows.
2. **Masumi concepts:** the registry NFT, V2 metadata, the escrow datum (all 19 fields, and who sets each), redeemers, the state machine, and the timing rules.
3. **The standard path:** the signing recipe step by step, and why each payload field is what it is, with source references into the Payment Service and Sokosumi.
4. **The x402 path:** how `@x402/cardano` is wired (issuer, commitment, registry claim, in-process facilitator), and the settle-after-handler ordering.
5. **Security invariants:** exact lock matching, unit normalization, seller address identity, pre-submit evaluation, and serial transactions.
6. **Adapting it:** replace the dummy task, change input fields, change the price or token, add dynamic pricing (what breaks), move to mainnet (policy ids, USDCx, Sokosumi whitelisting), and add persistence.
7. **Testing strategy:** what each test guards, and how to rerun the Payment Service verifier after Masumi updates.
8. **Known pitfalls:** the two tUSDM tokens, the public URL, cooldowns, the buyer auto-refund, and the quick-tunnel trap.

Exported functions get concise TSDoc.

### Task 8: Verify and review (check: A1–A7 green; one `code-reviewer` pass with findings resolved)

---

## Two decisions most likely to be wrong
1. **Seller side without the Masumi Payment Service.** We reproduce its signing payload and its transactions. If Masumi changes the payload (it is not versioned), Sokosumi hires break silently. The A6 test pins today's rules, not tomorrow's.
2. **tUSDM-only pricing, and x402 moved to `/x402/start_job`.** x402 buyers need tUSDM too, and the x402 route is not the MIP-003 URL. A tADA x402 price would need a second registry entry, because Sokosumi hides an agent with two differently-priced sources.

## Assumed / Unsure / Skipped
**Assumed**
- Sokosumi's buyer node pays from Sokosumi's own wallet (users spend credits), so the Sokosumi path needs no tUSDM from you.
- Sokosumi preprod runs code close to `8327114`, has tUSDM credit rows, and shows new agents by default.
- Its Payment Service has the escrow `addr_test1wzs4…37w4g` as a ready V2 source.
- Soko Bot exists on preprod.

**Unsure** (ranked)
1. Evolution-SDK COSE headers vs Mesh in a *live* Payment Service (it passed Mesh `checkSignature` in a harness).
2. The SubmitResult/Withdraw details for Payment Service locks (Task 3).
3. Whether Sokosumi's catalog needs manual `isShown` curation on preprod.
4. Registry health check through a tunnel.

**Skipped**
- Refund/dispute handling, mainnet, persistent jobs.
- Registry `UpdateAction`.
- A tADA x402 option.
- `provide_input`.
- Playwright e2e.

---

## Addendum A — unlisted 5 tADA x402 offer (2026-09-30)

**Goal.** An x402 buyer can pay **5 tADA** instead of 1 Masumi tUSDM, into the same Masumi escrow. The job runs and settles the same way (SubmitResult, then collect). The registry entry, the Sokosumi listing and the standard path stay unchanged.

**Why "unlisted".** The registry advertises exactly one price, 1 tUSDM. `@x402/cardano` checks every registry-claimed quote against it, in the UI and in the facilitator. The library takes `agentIdentifier` from the issuer config, not per offer (`chunk-W6LS2M6Y.mjs:429`). So the tADA offer is a **second issuer with no `agentIdentifier`**, on its own route. Its escrow datum carries an empty `agent_identifier`. The buyer still verifies the seller's signature over the terms and the job commitment; only the registry check is skipped.

| Change | Where | Risk |
|---|---|---|
| Second `x402ResourceServer` + `ExactCardanoScheme({ masumi: { seller, commitment } })` (no `agentIdentifier`), route `POST /x402/start_job/ada`, price `X402_ADA_PRICE_LOVELACE` (default 5 000 000; empty disables it) | `agent.ts`, `config.ts` | Medium |
| x402 jobs locate their lock **by the verified tx hash**. `locksOfTx(hash)` reads Blockfrost `/txs/{hash}/utxos` directly and keeps outputs with `address == escrow`, `consumed_by_tx == null` and `collateral == false`. It then loads those refs with `getUtxosByOutRef` (which alone does **not** filter spent outputs). An unknown tx (404) yields `[]`. Standard-path jobs keep the tUSDM scan | `chain.ts` (`locksOfTx`), `agent.ts` watcher | ⚠ funds, High |
| Every lookup returns `EscrowUtxo`s that carry their Evolution UTxO (`raw`). `submitResult` and `withdraw` use it directly; the `lastScan` cache is removed, so no lookup depends on another | `lockMatch.ts` type, `chain.ts` | ⚠ funds, High |
| Watcher: each job's lookup and SubmitResult run in their own try/catch, so one bad job never skips the others | `agent.ts` | Medium |
| `collect` also finds lovelace-only locks: it scans all escrow UTxOs (paginated, manual command). The strict filter stays (our seller key, state 1, result hash, collateral ≤ lovelace). "tUSDM > 0" becomes "tUSDM > 0 **or** lovelace − collateral return ≥ 1 tADA", so a fake lock can't make us pay a fee for nothing | `chain.ts` | ⚠ funds, High |
| Lock matching for lovelace: paid = lovelace − `collateral_return_lovelace` ≥ price (already implemented; now tested) | `lockMatch.ts` test | Medium |
| UI: choose the currency. For lovelace the lock output is `Assets.fromLovelace(lockedLovelace)` and the balance check uses lovelace with ~2 tADA fee headroom. Explicit `spendControls` cap each asset at its price; this is **required**, because lovelace is not a default asset and is rejected or uncapped otherwise (`@x402/core client/index.mjs:40-55, 509-518`) | `ui/App.tsx`, `ui/cip30Signer.ts` | Medium |
| `/demo/config` exposes both offers; `check-quote` checks both | `agent.ts`, `scripts/check.ts` | Low |
| README, DEVELOPER and `.env.example` explain the unlisted offer and its trade-off | docs | Low |

**Acceptance**
- B1: `POST /x402/start_job/ada` without payment returns 402 with `asset: "lovelace"`, `amount: "5000000"`, `extra.assetTransferMethod: "masumi"` and **no** `terms.agentIdentifier`. `npm run check-quote` verifies both offers with `verifyMasumiAuthorization`: the tADA offer with no registry validator, the tUSDM offer with the stub.
- B2: `lockMatch.test.ts` passes. An ADA lock paying ≥ 5 tADA net of its collateral return is accepted (extra tokens don't matter); one paying less is rejected, including a tUSDM-heavy lock with too little ADA; an ADA-only lock does not satisfy a tUSDM job.
- B2b: `test/chain.test.ts` (stubbed fetch) passes: `locksOfTx` returns `[]` for a 404, excludes an escrow output with `consumed_by_tx` set, and excludes non-escrow outputs.
- B3: typecheck, all tests and the build pass, including the standalone copy (A2).
- B4 (live, yours): the UI buys a job with tADA, and `npm run collect` withdraws it after unlock.

**Non-goals.** No change to the registry, Sokosumi or the standard path. No tADA on Sokosumi.

**Most likely wrong**
1. `collect`'s full scan of the shared escrow address could be slow on Blockfrost if preprod holds thousands of escrow UTxOs. Mitigation: `collect` is manual and paginated; if it's too slow, remember lock refs per job instead.
2. Trust in the unlisted offer: the buyer checks only the seller's signature, not the registry. Pinning `terms.sellerAddress` to the registered seller is possible but not done; the UI shows the seller address.

---

## Addendum B — hire via Sokosumi from the UI (2026-09-30)

**Goal.** The UI gets a third way to buy a job: "via Sokosumi". It creates a Sokosumi job for this agent with the operator's Sokosumi API key and shows the job's status and result. Sokosumi then hires the agent through the standard path (MIP-003 `start_job`, its payment node locks the tUSDM), paid with Sokosumi credits.

**Decisions (user):** the key lives in `masumi/.env`, used through an agent-side proxy. Build now and verify against a stub Sokosumi, because the agent is still hidden there (live hires 404).

**Design**

| Change | Where | Risk |
|---|---|---|
| `SOKOSUMI_API_KEY` (optional; the feature is off without it), `SOKOSUMI_API_URL` (default `https://api.preprod.sokosumi.com/v1`), `SOKOSUMI_AGENT_ID` (optional), `SOKOSUMI_MAX_CREDITS` (optional cap per job) | `config.ts`, `.env.example` | Low |
| Small client that unwraps `{ data, meta }`. Paging contract: `GET /agents?kind=cardano&limit=50&cursor=<id>`, following `meta.pagination.nextCursor` until it is null (`sokosumi helpers/pagination.ts:35-46`). The unique-match check spans all pages. `agentId()` uses `SOKOSUMI_AGENT_ID`, or else pages through `GET /agents?kind=cardano` for an **exact, unique** `AGENT_NAME` match and fails otherwise. Also `inputSchema(id)`, `createJob(id, { inputData, inputSchema, maxCredits })` and `job(id)`. A 404 on the agent explains that Sokosumi doesn't list or show it. `fetch` is injectable | `src/sokosumi.ts` (new) | Medium |
| **Operator-only proxy on a separate port, bound to 127.0.0.1** (`SOKOSUMI_PROXY_PORT`, default 8788): `POST /sokosumi/hire {text}` and `GET /sokosumi/jobs/:id`. Your tunnel forwards only to the public agent port, so the internet can't reach it. **Browsers can**, through DNS rebinding or cross-site posts from a page you have open. So the proxy also:
- rejects any `Host` other than `127.0.0.1:<port>` or `localhost:<port>` (Vite forwards with `changeOrigin: true`);
- rejects any `Origin` other than the local UI (`http://localhost:5174` / `http://127.0.0.1:5174`). A missing Origin (curl) is allowed;
- requires `Content-Type: application/json` and sends no CORS headers;
- validates the text (1-500 characters) before calling Sokosumi.

It never retries the create call (a retry would be a second paid job) and returns only `{ id, status, result, name }`, never the key. `SOKOSUMI_ORGANIZATION_SLUG` (optional) is sent on both the create and the read, for credits held by an organization; without it the key user's personal workspace pays | `agent.ts` | ⚠ auth (spends credits), Medium |
| Vite proxies `/sokosumi` to that port, and `/demo/config` reports `sokosumi: { enabled }` | `vite.config.ts`, `agent.ts` | Low |
| UI: a third "Pay with" option, "Sokosumi credits". It has its own rail and shows the Sokosumi job id and result. No wallet is needed for this option. Every Sokosumi status is mapped: `payment_pending` → paying; `started`, `processing`, `result_pending` → working; `completed` → done. Everything else (`failed`, `payment_failed`, `input_required`, `refund_*`, `dispute_*`) is terminal: "stopped: <status>", and polling ends. The button stays disabled while the create request is in flight. The job `name` is sent, so Sokosumi skips generating one | `ui/App.tsx` | Low |
| README section and a DEVELOPER note (proxy, port isolation, visibility dependency) | docs | Low |

**Acceptance**
- C1: `test/sokosumi.test.ts` (stubbed fetch) passes. It sends a Bearer header on every call and unwraps `data`. It resolves the agent by `SOKOSUMI_AGENT_ID`, or by a unique exact name across pages, and rejects zero or several matches. `createJob` posts `{ inputSchema, inputData: { text }, maxCredits? }` to `/agents/{id}/jobs`. A 404 carries the visibility hint.
- C1b: the stub serves the real paging shape; the test asserts the client sends `cursor=<nextCursor>`, stops on null, and finds a match on page 2.
- C2: with a local fake Sokosumi (`SOKOSUMI_API_URL` pointing at a Node stub server), `POST 127.0.0.1:8788/sokosumi/hire` returns a job, and `GET /sokosumi/jobs/:id` returns its status and result. The public agent port answers 404 on `/sokosumi/*`. Without `SOKOSUMI_API_KEY`, the proxy doesn't start and `/demo/config` says it's disabled. `POST` with `Host: evil.example` → 403, with `Origin: https://evil.example` → 403, with `text/plain` → 415; none of them reach the stub.
- C2b: a pure `sokosumiStage(status)` maps every Sokosumi status; the unit test covers all 12 values and asserts `failed` is terminal.
- C3: typecheck, all tests and the build pass, including the standalone copy.
- C4 (live, yours, once the agent is visible): a hire from the UI completes on Sokosumi preprod.

**Non-goals.** Handling Sokosumi's `input_required`, refunds or disputes; multi-user access; exposing the proxy beyond this machine.

**Most likely wrong**
1. Name-based lookup. `GET /agents` exposes no registry id, so matching `AGENT_NAME` could hit someone else's agent with the same name. Mitigation: exact and unique match, or set `SOKOSUMI_AGENT_ID`, which the UI shows after the first lookup. Sokosumi may also show a metadata-override name that differs from `AGENT_NAME`; then set `SOKOSUMI_AGENT_ID`.
2. Response shapes are read from Sokosumi's source at `8327114`, not from the live preprod API. The client parses defensively and reports unexpected shapes.
