# Masumi agent demo (Cardano preprod)

A dummy AI agent that is registered on the [Masumi](https://masumi.network) network. You can hire it in two ways, and both lock the payment in Masumi's escrow contract:

- **Through Sokosumi.** The agent speaks Masumi's standard agent API (MIP-003). It is registered in exactly the shape Sokosumi lists in its [preprod catalog](https://preprod.sokosumi.com/agents), and Sokosumi's Soko Bot or API can hire it. Whether it becomes *visible* there depends on a Sokosumi setting (see step 5).
- **Through x402.** The main demo's **Masumi agent** tab pays with a browser wallet, using the official [`@x402/cardano`](https://www.npmjs.com/package/@x402/cardano) library. You can pay the registered price (1 Masumi tUSDM) or an unlisted 5 tADA price.

The agent reverses and upper-cases your text. When it sees the payment in escrow, it does the job and writes the result hash on chain. After the unlock time, the seller collects the money with one command.

This folder is the agent: it runs, registers, does the work and collects. Its web UI is the **Masumi agent** tab of the main demo next to this folder (`../server` and `../frontend`).

**Just want to look?** Start the main demo (`npm run dev` at the repository root), open the **Masumi agent** tab and click **Replay an example**. No agent, wallet or tokens are needed.

**Read in this order:** this file (concepts and running it) → [docs/DEVELOPER.md](docs/DEVELOPER.md) (design, glossary, how to build your own agent) → [docs/FLOWS.md](docs/FLOWS.md) (every HTTP message and transaction). New to x402 itself? Start with the main demo's [guide](../docs/x402/guide.md).

```
buyer ──pays──▶ Masumi escrow ──agent sees lock──▶ job runs ──▶ result hash on chain ──unlock time──▶ seller collects
```

Everything here runs on **preprod** with test tokens. The escrow contract, registry and tokens are Masumi's real preprod deployments.

## How it works (two minutes)

- **Escrow, not a transfer.** In the main demo's Transactions tab, x402 pays the seller directly. Here the buyer pays into Masumi's escrow smart contract (`vested_pay`). The seller can take the money only after it has put a hash of the result on chain *and* the unlock time has passed. A successful x402 payment therefore means "locked in escrow", not "paid to the seller".
- **The datum is the contract's memory.** The escrow output carries 19 fields: buyer, seller, the seller-signed terms (nonces, input hash, agent id), four deadlines, the result hash and a state. Later transactions are checked against it. Nothing is checked when the money is locked, so the agent re-checks every field it signed before doing the work.
- **The registry NFT is the agent's listing.** `npm run register` mints one NFT whose metadata holds the name, public URL, price and escrow address. Its asset id is your `MASUMI_AGENT_IDENTIFIER`. Buyers check offers against it, and Sokosumi builds its catalog from it.
- **Roles.**
  - *Buyer*: your browser wallet (x402) or Sokosumi's payment node.
  - *Seller*: this agent. Its wallet signs terms, holds the NFT and receives the money.
  - *Facilitator*: the x402 component that verifies the buyer's signed lock and broadcasts it. Here it runs inside the agent and holds no keys.
- **Two ways in, one escrow.**
  - *Standard Masumi (MIP-003)*: Sokosumi calls `POST /start_job`, gets signed terms, and its own payment node builds the lock.
  - *x402*: the agent answers `402` with escrow terms in `PAYMENT-REQUIRED`, your wallet signs the lock, and the paid retry delivers it.
  - Both use the same contract, datum and watcher, and both are collected the same way.
- **Deadlines.** pay-by → submit-result → unlock → dispute end. The result must be on chain before submit-result, and the seller may collect from unlock. The gap in between is the buyer's window to dispute.
- **Collecting is a separate, later step.** Nothing pays the seller automatically. After the unlock time, the operator runs `npm run collect`. It moves each finished escrow to the seller and returns the buyer's ADA deposit in the same transaction.

## What you need

| | Why |
|---|---|
| Node.js 22+ | Runs the agent and its scripts (and the main demo) |
| A [Blockfrost](https://blockfrost.io) **preprod** project id | Chain reads and transaction submission |
| A **seller wallet** (24-word mnemonic) with ~20 tADA | Registers the agent, signs escrow transactions, receives payments |
| A **public HTTPS URL** for the agent | The Masumi registry checks it; Sokosumi calls it |
| For the Masumi agent tab (x402): a **buyer** browser wallet (Eternl, Lace, …) on preprod, not the seller's | Pays for jobs. Registered offer: about 3 tADA plus 1 Masumi tUSDM. tADA offer: about 7 tADA. The amounts are approximate and include fees and the refundable deposit |

Get tADA from the [Cardano faucet](https://docs.cardano.org/cardano-testnets/tools/faucet/) or the [Masumi dispenser](https://dispenser.masumi.network/). Masumi's dispenser also offers "USDM". Check that the token it sends has policy `16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde`. That's the tUSDM Masumi and Sokosumi use. Another "tUSDM" on preprod (policy `e675b46e…`) won't work here. The main demo's **Transactions** tab uses that other token by default, so you may need both: `e675b46e…` for the Transactions tab and `16a55b2a…` for the Masumi agent tab.

To find the seller address to fund, run `npm run register` once (step 3). It prints `seller addr_test1…` and then fails for lack of funds before anything is signed or submitted. Fund that address and run it again.

Use a fresh wallet for the seller. Its mnemonic sits in a plain `.env` file.

### First-run checklist

- [ ] Main demo set up once (`./setup.sh`, `server/.env`, `frontend/.env`); see [../README.md](../README.md)
- [ ] `masumi/.env`: Blockfrost id, a fresh `SELLER_MNEMONIC`, a stable `AGENT_PUBLIC_URL`, final `AGENT_*` listing fields
- [ ] Seller address funded with about 20 tADA
- [ ] Tunnel running to `localhost:8787`
- [ ] `npm run register` done, and `MASUMI_AGENT_IDENTIFIER` pasted into `.env`
- [ ] `npm run agent` (in `masumi/`) and `npm run dev` (at the root) running
- [ ] `npm run check-registry`: every line `ok`, including `/availability`
- [ ] Buyer wallet (not the seller's) on preprod, with tADA and Masumi tUSDM `16a55b2a…` (not `e675b46e…`)
- [ ] Optional, for Sokosumi: agent visible in the catalog; `SOKOSUMI_API_KEY` and `SOKOSUMI_AGENT_ID` (Sokosumi's UUID) in `server/.env`; credits available
- [ ] 40–60 minutes after a job: once no job is still in progress, stop the agent and run `npm run collect`

## 1. Install and configure

```sh
cd masumi
npm install
cp .env.example .env
```

Fill in `.env`:

| Variable | Value |
|---|---|
| `BLOCKFROST_PROJECT_ID` | Your preprod project id |
| `SELLER_MNEMONIC` | The seller wallet's 24 words |
| `AGENT_PUBLIC_URL` | The public URL from step 2, without a trailing slash |
| `PRICE_TUSDM_UNITS` | Price in tUSDM base units. The default `1000000` is 1 tUSDM |
| `X402_ADA_PRICE_LOVELACE` | Optional x402-only price in lovelace. The default `5000000` is 5 tADA; leave it empty to turn the tADA offer off |
| `MASUMI_AGENT_IDENTIFIER` | Leave empty for now. Step 3 prints it |

`AGENT_NAME`, `AGENT_DESCRIPTION`, `AGENT_AUTHOR`, `AGENT_TAGS` and `AGENT_IMAGE` set what the registry and Sokosumi show.

This key stays with the agent. The Masumi agent tab uses the main demo's own `VITE_BLOCKFROST_PROJECT_ID` (in `../frontend/.env`), which ends up in the browser bundle, so use a preprod key there you are fine exposing. The mnemonic never leaves the agent.

## 2. Give the agent a public URL

The Masumi registry marks an agent **Online** only when `GET {AGENT_PUBLIC_URL}/availability` answers from the public internet. It rejects `localhost` and private addresses. Sokosumi lists only Online agents.

The URL is written into the registry NFT, so pick one that stays the same. A named Cloudflare tunnel works well:

```sh
cloudflared tunnel create masumi-agent
cloudflared tunnel route dns masumi-agent agent.your-domain.com
cloudflared tunnel run --url http://localhost:8787 masumi-agent
```

A quick tunnel (`cloudflared tunnel --url http://localhost:8787`) is fine for a first try. Its URL changes on every restart, though, and then you'd have to register again.

## 3. Register the agent

```sh
npm run register
```

This mints the agent's registry NFT to the seller wallet. The NFT records the name, `AGENT_PUBLIC_URL`, the price in tUSDM and Masumi's escrow address. The script prints the transaction and a line like this:

```
MASUMI_AGENT_IDENTIFIER=67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b10…000000
```

Put that line in `.env`. Registration costs a little tADA, and the NFT output holds about 2 tADA that you get back when you deregister.

Once the transaction has confirmed, check everything the hire paths depend on:

```sh
npm run check-registry
```

Until the agent runs (step 4), the `/availability` line warns that the agent is unreachable. That is expected; run the check again after step 4.

Don't move the NFT out of the seller wallet. Sokosumi's payment node checks that the address signing the terms is the address holding the NFT.

## 4. Run it

```sh
npm run agent
```

The agent listens on `http://localhost:8787`, and your tunnel makes it public. Keep it running: it watches the escrow every 10 seconds and processes paid jobs. If you change `PORT` in `.env`, change `MASUMI_AGENT_URL` in `../server/.env` and the tunnel target too.

A full setup uses four terminals:

| Terminal | Directory | Command |
|---|---|---|
| 1 | any | your tunnel, e.g. `cloudflared tunnel run …` |
| 2 | `masumi/` | `npm run agent` |
| 3 | repository root | `npm run dev` (the main demo) |
| 4 | `masumi/` | `npm run check-*`, later `npm run collect` |

For the UI, start the main demo from the repository root (see `../README.md` for its one-time setup):

```sh
npm run dev
```

Open `http://localhost:5173` and choose the **Masumi agent** tab. The demo server reaches the agent at `MASUMI_AGENT_URL` (default `http://127.0.0.1:8787`, set in `../server/.env`).

To confirm the running agent answers exactly the way both buyers expect, run in terminal 4:

```sh
npm run check-quote      # the x402 offer passes the buyer's checks
npm run check-purchase   # the Masumi start_job answer passes Sokosumi's checks
```

## 5. Hire it

**Which route needs the tunnel.** The x402 route works with only the agent and the main demo running, as long as `AGENT_PUBLIC_URL` still equals the registered URL. Sokosumi hires need the tunnel up and the agent Online and visible, because Sokosumi calls `POST /start_job` on the public URL. If the tunnel URL changed since you registered, the registered offer fails the registry check; the tADA offer still works.

### From Sokosumi (Soko Bot or API)

- **Finding the agent.** Sokosumi syncs the Masumi registry about every 5 minutes. It lists an agent that is Online, priced in Masumi tUSDM and paid through Masumi's V2 escrow, which is how this agent registers. **But** Sokosumi stores each new agent as shown or hidden according to its `SHOW_AGENTS_BY_DEFAULT` setting, which defaults to hidden in its code. Masumi's docs say preprod agents appear automatically; if yours doesn't show up at [preprod.sokosumi.com/agents](https://preprod.sokosumi.com/agents) after ~10 minutes, ask the Masumi team to show it. You need a Sokosumi account with a seat to see the catalog.

  To confirm your side is done, look the agent up in Masumi's public registry. It should say `"status":"Online"`:

  ```sh
  curl -s -X POST https://registry.masumi.network/api/v1/registry-entry/ \
    -H "token: public-test-key-masumi-registry-c23f3d21" -H "Content-Type: application/json" \
    -d '{"network":"Preprod","filter":{"assetIdentifier":"'$MASUMI_AGENT_IDENTIFIER'","status":["Online","Offline","Invalid"]}}'
  ```
- **Hiring it.** The Sokosumi web app no longer has a Hire button; the catalog is for browsing. Hire the agent through **Soko Bot** (ask it to use your agent by name) or through Sokosumi's API (`POST /v1/agents/{id}/jobs`). Sokosumi's payment node pays from Sokosumi's wallet, so you don't need tUSDM for this.

You can follow a Sokosumi job in the agent's log:

```
[job 6f1c…] completed; SubmitResult 9a4e…
```

### Through Sokosumi, from the Masumi agent tab

Put these in the main demo's `server/.env` and restart `npm run dev` at the repository root:

- `SOKOSUMI_API_KEY`, from Sokosumi's **Developer → API keys**.
- **Either** `SOKOSUMI_AGENT_ID`, Sokosumi's own id for your agent: a UUID such as `01a0f73f-…`, from the agent's Sokosumi page or `GET /v1/agents`. It is **not** `MASUMI_AGENT_IDENTIFIER`, and the server refuses to start with that.
- **Or** `SOKOSUMI_AGENT_NAME`, the name exactly as Sokosumi lists it (normally your `AGENT_NAME`).

The tab then offers a third way to pay, **Through Sokosumi**, with the button **Hire via Sokosumi**. It creates the job through Sokosumi's API, and Sokosumi hires the agent exactly as Soko Bot would. The money rail follows the Sokosumi job to its result.
- **Your key stays in the demo server.** The server only listens on `127.0.0.1`, and its Sokosumi routes answer only the demo page's origin (`FRONTEND_ORIGINS`). Never tunnel or expose the demo server while the key is set; only the agent (port 8787) goes through the tunnel.
- **Moving from an older setup?** The agent no longer uses `SOKOSUMI_*`. Move those lines from `masumi/.env` to `server/.env`; the agent prints a reminder while the key is still here.
- **It needs the agent to be visible on Sokosumi.** Until then, Sokosumi answers "not shown" (a 404).
- **`SOKOSUMI_MAX_CREDITS`** caps what one job may cost. **`SOKOSUMI_ORGANIZATION_SLUG`** chooses the organization whose credits pay; without it, your personal workspace pays.

The agent's log shows the same `completed; SubmitResult …` line for these jobs.

### With x402, from the Masumi agent tab

No wallet at hand? Click **Replay an example**. It runs the same flow code against a simulated agent and wallet (clearly labelled, no money moves, no explorer links), so you can explore every step and its data.

1. Open the main demo at `http://localhost:5173`, choose the **Masumi agent** tab and connect your **buyer** wallet. It must not be the seller wallet.
2. Under **How to pay**, choose:
   - **Registered price** (`1.00 tUSDM`). The price in the registry; the UI checks it on chain. Your wallet also locks a deposit of about 1.5 tADA, which comes back to you in the seller's collect transaction.
   - **Unlisted tADA price** (`5.00 tADA`). Handy when you have no Masumi tUSDM. It uses the same escrow and the same job, but the offer doesn't carry the agent's registry identity, so the UI checks only the seller's signature, not the registry. If the price alone is below the escrow output's minimum ADA, the lock adds a refundable deposit that goes back to you when the seller collects; at 5 tADA it usually needs none.
3. Enter some text under **Job input** and click **Pay 1.00 tUSDM and run** (or the tADA equivalent).
4. The UI checks the offer before you sign:
   - the seller's signature over the terms;
   - for the registered price: the registry entry, price and URL on chain;
   - that the offer commits to your text.
5. Your wallet signs a transaction that locks the price in Masumi's escrow.
6. Follow the numbered steps. **Select any step** to see who acted, why, and the real data in the inspector on the right. Its tabs are **HTTP**, **Explain**, **Escrow datum** and **Step data**, and you can drag its edge to make it wider. The data includes:
   - the decoded 402 offer and the signed terms;
   - the escrow datum, with all 19 fields explained;
   - the settlement receipt and the agent's view of the lock.

   The money rail above the steps shows where the money is, and labels where that knowledge comes from: *observed*, *reported by the agent*, *derived from unlock_time*, or *unknown* after a failure. On the Sokosumi route it is always *inferred from Sokosumi's status*. The money never moves to the agent on the rail, because the withdrawal happens later and is not observed. Settling takes one confirmation, usually under two minutes.
7. The result text appears in step 7, *The agent submits the result hash* (**Step data** tab). Step 8 says when the seller may collect.

## 6. Collect the payment

Escrowed funds unlock for the seller at the job's `unlockTime`. The gap between the result deadline and the unlock time is the buyer's window to dispute. Only after `unlockTime` does the contract let the seller withdraw.

| Hired via | Result must be on chain before | Seller can collect from |
|---|---|---|
| Sokosumi (standard path) | 40 min after `start_job` | 60 min after `start_job` |
| Masumi agent tab (x402) | ~20 min after paying | ~40 min after paying |

Stop the agent once no job is still in progress (the log shows `completed; SubmitResult …` for every job), so the two don't spend the same wallet inputs. Then run:

```sh
npm run collect
```

It finds every escrow of this seller that has a submitted result and a passed unlock time, whether paid in tUSDM or tADA, and withdraws each one to the seller wallet. It reads all UTxOs at Masumi's shared escrow address, so it can take a while.

## 7. Deregister

```sh
npm run deregister
```

This burns the registry NFT. The registry marks the agent deregistered, and Sokosumi drops it.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Agent is Offline in the registry, or missing on Sokosumi | `AGENT_PUBLIC_URL` isn't reachable from the internet, redirects, or changed since registration. Check `curl $AGENT_PUBLIC_URL/availability`. |
| Missing on Sokosumi, but Online in the registry | Sokosumi hasn't synced yet (~5 min), or it stored the agent as hidden (`SHOW_AGENTS_BY_DEFAULT`, default hidden in its code). Ask the Masumi team to show it. Also check the price is in Masumi tUSDM. |
| Sokosumi hire fails at purchase | Run `npm run check-purchase`. The usual causes are an NFT moved away from the seller address, or a `PRICE_TUSDM_UNITS` that differs from the registered price. |
| Masumi agent tab: "Escrow offer rejected: …agent_identifier…" | The registry check failed. Run `npm run check-registry`. |
| Masumi agent tab: wallet can't build the transaction | The buyer lacks Masumi tUSDM (policy `16a55b2a…`) or tADA for fees and the escrow's min-UTxO. |
| A job stays `awaiting_payment` | The lock never arrived, or its datum doesn't match the signed terms. The agent logs why it ignored a candidate lock. The job fails 5 min before `submitResultTime`. |
| `collect` finds nothing | Unlock time not reached yet (see the table above), or the result was never submitted. |
| Masumi agent tab: Sokosumi "does not show … to your account" | `SOKOSUMI_AGENT_ID` must be Sokosumi's UUID (see step 5), and the agent must be visible in your Sokosumi catalog. |
| Masumi agent tab: "The agent isn't reachable" | Start `npm run agent` here, and check `MASUMI_AGENT_URL` in `../server/.env`. |

## Limits

- Jobs live in memory. After a restart, the agent can't finish jobs it had already sold. Keep it running until the results are submitted. `npm run agent` restarts the agent when you edit its source, which drops jobs too. Collecting still works: `npm run collect` reads everything from the chain.
- Only the happy path is covered: lock, result, collect. Refunds and disputes use the buyer's own tooling. For Sokosumi, that is its payment node: if no result is submitted within 10 minutes after `submitResultTime`, it refunds the buyer automatically.
- **An x402 buyer has no refund button in this demo.** If the agent never submits a result, the lock stays in escrow until a refund transaction is built with Masumi's tooling. Pay small amounts and keep the agent running until results are submitted.
- x402 payments are invisible to the Masumi Payment Service. That's why this demo builds its own result and collect transactions.
- Preprod only.
