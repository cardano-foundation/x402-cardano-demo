# Masumi agent demo (Cardano preprod)

A dummy AI agent that is registered on the [Masumi](https://masumi.network) network. You can hire it in two ways, and both lock the payment in Masumi's escrow contract:

- **Through Sokosumi.** The agent speaks Masumi's standard agent API (MIP-003). It is registered in exactly the shape Sokosumi lists in its [preprod catalog](https://preprod.sokosumi.com/agents), and Sokosumi's Soko Bot or API can hire it. Whether it becomes *visible* there depends on a Sokosumi setting (see step 5).
- **Through x402.** A small web UI pays with a browser wallet, using the official [`@x402/cardano`](https://www.npmjs.com/package/@x402/cardano) library. You can pay the registered price (1 Masumi tUSDM) or an unlisted 5 tADA price.

The agent reverses and upper-cases your text. When it sees the payment in escrow, it does the job and writes the result hash on chain. After the unlock time, the seller collects the money with one command.

This file is the operator guide. To build your own agent on this code, read [docs/DEVELOPER.md](docs/DEVELOPER.md).

```
buyer ──pays──▶ Masumi escrow ──agent sees lock──▶ job runs ──▶ result hash on chain ──unlock time──▶ seller collects
```

Everything here runs on **preprod** with test tokens. The escrow contract, registry and tokens are Masumi's real preprod deployments.

## What you need

| | Why |
|---|---|
| Node.js 22+ | Runs the agent, scripts and UI |
| A [Blockfrost](https://blockfrost.io) **preprod** project id | Chain reads and transaction submission |
| A **seller wallet** (24-word mnemonic) with ~20 tADA | Registers the agent, signs escrow transactions, receives payments |
| A **public HTTPS URL** for the agent | The Masumi registry checks it; Sokosumi calls it |
| For the x402 UI: a **buyer** browser wallet (Eternl, Lace, …) on preprod | Pays for jobs: tADA only (tADA offer), or tADA for fees plus **Masumi tUSDM** (registered offer) |

Get tADA from the [Cardano faucet](https://docs.cardano.org/cardano-testnets/tools/faucet/) or the [Masumi dispenser](https://dispenser.masumi.network/). Masumi's dispenser also offers "USDM". Check that the token it sends has policy `16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde`. That's the tUSDM Masumi and Sokosumi use. Another "tUSDM" on preprod (policy `e675b46e…`) won't work.

Use a fresh wallet for the seller. Its mnemonic sits in a plain `.env` file.

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

The UI reads `BLOCKFROST_PROJECT_ID` too, so the key ends up in the browser bundle (and in `dist/` after `npm run build`). Use a preprod key you are fine exposing. The mnemonic never leaves the agent.

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

Don't move the NFT out of the seller wallet. Sokosumi's payment node checks that the address signing the terms is the address holding the NFT.

## 4. Run it

```sh
npm run dev
```

- The agent listens on `http://localhost:8787`. Your tunnel makes it public.
- The UI runs on `http://localhost:5174`.

Keep both running. The agent watches the escrow every 10 seconds and processes paid jobs.

To confirm the running agent answers exactly the way both buyers expect, open a second terminal and run:

```sh
npm run check-quote      # the x402 offer passes the buyer's checks
npm run check-purchase   # the Masumi start_job answer passes Sokosumi's checks
```

## 5. Hire it

### From Sokosumi

- **Finding the agent.** Sokosumi syncs the Masumi registry about every 5 minutes. It lists an agent that is Online, priced in Masumi tUSDM and paid through Masumi's V2 escrow, which is how this agent registers. **But** Sokosumi stores each new agent as shown or hidden according to its `SHOW_AGENTS_BY_DEFAULT` setting, which defaults to hidden in its code. Masumi's docs say preprod agents appear automatically; if yours doesn't show up at [preprod.sokosumi.com/agents](https://preprod.sokosumi.com/agents) after ~10 minutes, ask the Masumi team to show it. You need a Sokosumi account with a seat to see the catalog.

  To confirm your side is done, look the agent up in Masumi's public registry. It should say `"status":"Online"`:

  ```sh
  curl -s -X POST https://registry.masumi.network/api/v1/registry-entry/ \
    -H "token: public-test-key-masumi-registry-c23f3d21" -H "Content-Type: application/json" \
    -d '{"network":"Preprod","filter":{"assetIdentifier":"'$MASUMI_AGENT_IDENTIFIER'","status":["Online","Offline","Invalid"]}}'
  ```
- **Hiring it.** The Sokosumi web app no longer has a Hire button; the catalog is for browsing. Hire the agent through **Soko Bot** (ask it to use your agent by name) or through Sokosumi's API (`POST /v1/agents/{id}/jobs`). Sokosumi's payment node pays from Sokosumi's wallet, so you don't need tUSDM for this.

**From this demo's UI.** Put a Sokosumi API key in `.env` (`SOKOSUMI_API_KEY`, from Sokosumi's **Developer → API keys**) and restart `npm run dev`. The UI then offers a third way to pay: **Sokosumi credits**. It creates the job through Sokosumi's API, and Sokosumi hires the agent exactly as Soko Bot would. The rail follows the Sokosumi job to its result.
- **Your key stays on this machine.** The agent uses it through a proxy on `127.0.0.1:8788`. Your tunnel doesn't forward that port, and the proxy only answers the local UI.
- **It needs the agent to be visible on Sokosumi.** Until then, Sokosumi answers "not shown" (a 404).
- **The agent is found by `AGENT_NAME`.** If several Sokosumi agents share that name, or Sokosumi displays a different name, set `SOKOSUMI_AGENT_ID`.
- **`SOKOSUMI_MAX_CREDITS`** caps what one job may cost.

You can follow the job in the agent's log:

```
[job 6f1c…] completed; SubmitResult 9a4e…
```

### From the x402 UI

1. Open `http://localhost:5174` and connect your **buyer** wallet. It must not be the seller wallet.
2. Choose how to pay:
   - **1.00 tUSDM (registered price).** The price in the registry; the UI checks it on chain.
   - **5.00 tADA (unlisted).** Handy when you have no Masumi tUSDM. It uses the same escrow and the same job, but the offer doesn't carry the agent's registry identity, so the UI checks only the seller's signature, not the registry. The lock also holds a small refundable deposit (about 1.5 tADA) that goes back to you when the seller collects.
3. Enter some text and click **Pay … and run**.
4. The UI checks the offer before you sign:
   - the seller's signature over the terms;
   - for the registered price: the registry entry, price and URL on chain;
   - that the offer commits to your text.
5. Your wallet signs a transaction that locks the price in Masumi's escrow.
6. Watch the escrow rail. It shows: lock submitted, funds in escrow, result submitted. Each step links to its transaction. Settling takes one confirmation, usually under two minutes.
7. The result appears in the UI.

## 6. Collect the payment

Escrowed funds unlock for the seller at the job's `unlockTime`:

| Hired via | Result must be on chain before | Seller can collect from |
|---|---|---|
| Sokosumi (standard path) | 40 min after `start_job` | 60 min after `start_job` |
| x402 UI | ~20 min after paying | ~40 min after paying |

Stop the agent first, so the two don't spend the same wallet inputs. Then run:

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
| x402 UI: "Escrow offer rejected: …agent_identifier…" | The registry check failed. Run `npm run check-registry`. |
| x402 UI: wallet can't build the transaction | The buyer lacks Masumi tUSDM (policy `16a55b2a…`) or tADA for fees and the escrow's min-UTxO. |
| A job stays `awaiting_payment` | The lock never arrived, or its datum doesn't match the signed terms. The agent logs why it ignored a candidate lock. The job fails 5 min before `submitResultTime`. |
| `collect` finds nothing | Unlock time not reached yet (see the table above), or the result was never submitted. |

## Limits

- Jobs live in memory. After a restart, the agent can't finish jobs it had already sold. Keep it running until the results are submitted. `npm run dev` restarts the agent when you edit its source, which drops jobs too. Collecting still works: `npm run collect` reads everything from the chain.
- Only the happy path is covered: lock, result, collect. Refunds and disputes use the buyer's own tooling (for Sokosumi, its payment node). If no result is submitted within 10 minutes after `submitResultTime`, Sokosumi's node refunds the buyer automatically.
- x402 payments are invisible to the Masumi Payment Service. That's why this demo builds its own result and collect transactions.
- Preprod only.
