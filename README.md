# FreshProof

**Data purchases with an enforceable freshness promise, for AI agents, paid with x402 on Cardano.**

Built for the TOKEN2049 Origins Hackathon, Agentic Payments on Cardano track.

---

## Intro

AI agents increasingly buy data and act on it at machine speed. When an agent buys data today, it pays even if the data arrives too old to use.

FreshProof is a data marketplace where every purchase carries a **freshness promise**:

- The buyer states how fresh the data must be, for example "an ETH price no more than 10 seconds old".
- The seller is paid only if the delivery meets that promise.
- If the delivery misses it, the buyer pays nothing.

## Problem

- Gartner estimates poor data quality costs organizations an average of **$12.9 million a year**.
- Juniper projects agentic commerce could reach **$1.5 trillion a year by 2030**.

When agents spend real money at machine speed, outdated data becomes a financial risk. We focus on one specific failure: **buyers paying for data that arrives too old to use.**

Example: an agent compares the Bitcoin price on two exchanges. One price is ten seconds old, and the opportunity is already gone. The seller still gets paid. The buyer carries the risk.

## Solution

Every purchase carries a freshness promise that is enforced at payment time:

| Step | What happens |
|---|---|
| 1. Request | The buyer agent asks for a price with a maximum age (`maxAge`), e.g. ETH ≤ 10 s. |
| 2. Pay | The seller answers HTTP `402 Payment Required`. The buyer signs a USDM payment on Cardano. The payment is **verified but held, not broadcast**. |
| 3. Deliver | The marketplace fetches the latest trade and records its age at delivery. |
| 4. Check | **Age ≤ maxAge** → the payment is broadcast and the seller is paid (`APPROVE`). **Age > maxAge** → the signed payment is dropped and the buyer is never charged (`REJECT`). |

Who it is for:

- **Buyers:** teams running crypto trading agents, who need automatic checks across thousands of data purchases.
- **Sellers:** can charge more for tighter freshness promises.
- **FreshProof:** earns a fee on successful transactions only.

We do not insure trading losses. We make sellers accountable for delivery.

## Tech stack

| Layer | Technology |
|---|---|
| Blockchain | **Cardano Preprod** testnet |
| Payment protocol | **x402** (HTTP 402), `exact` scheme on `cardano:preprod`, via [`@x402/cardano`](https://www.npmjs.com/package/@x402/cardano) and `@x402/core` |
| Facilitator | Cardano Foundation hosted Preprod facilitator, `https://x402.preprod.dev.ecosyseng.cf-deployments.org`: verifies the signed payment and broadcasts it only on settlement |
| Stablecoin | Preprod **USDM** (test USDM), paid per query (default 0.1 USDM) |
| Chain data | **Blockfrost** Preprod API: chain tip, transaction lookup, buyer balance before and after |
| Price source | Coinbase Exchange API: latest trade with its timestamp, used to measure data age |
| Marketplace | Node.js x402 resource server: [`.claude/skills/freshproof/market.mjs`](.claude/skills/freshproof/market.mjs) |
| Buyer agent | Node.js CLI that signs with a buyer wallet and prints a receipt: [`.claude/skills/freshproof/buy.mjs`](.claude/skills/freshproof/buy.mjs); also usable as a Claude Code skill (`/freshproof`) |
| Demo UI | Next.js 16 + React 19 + Tailwind CSS 4: [`app/demo.tsx`](app/demo.tsx) |
| Escrow design | Masumi escrow flow (fund → submit result → verdict), shown in the demo UI and the `--simulate` mode |

## Transactions

On-chain transactions from our demo runs on Cardano Preprod:

| # | Run | Asset | Max age | Recorded age | Verdict | Amount | Tx hash |
|---|---|---|---|---|---|---|---|
| 1 | Fresh delivery | ETH/USD | 10 s | `[__ s]` | ✅ APPROVE, seller paid | 0.1 USDM | [`[tx hash]`](https://preprod.cardanoscan.io/transaction/[tx-hash]) |
| 2 | Outdated delivery | ETH/USD | 0.000001 s | `[__ ms]` | ❌ REJECT, never broadcast | 0 USDM charged | `[signed tx hash]`: intentionally **not** on chain |

For the REJECT run, the hash belongs to the signed payment that was dropped. Looking it up on the explorer returns "not found", which is the proof that the buyer was never charged.

## Proof of Cardano usage

- **Settled payment on Preprod:** https://preprod.cardanoscan.io/transaction/[tx-hash]. It shows USDM moving from the buyer wallet to the seller address.
- **Seller address:** `[addr_test1…]`
- **Buyer address:** `[addr_test1…]`
- **USDM asset:** the Preprod USDM that `@x402/cardano` resolves for `$` prices: `[policyId.assetName]`
- **Receipt evidence:** each `buy.mjs` run prints the tx hash, an explorer link, the block and slot found through Blockfrost, and the buyer's tUSDM balance before and after.
- **Screenshots:** `[add a screenshot of the APPROVE receipt and of the explorer page]`

## Run it

Requirements: Node.js 24+, a Blockfrost **Preprod** project ID, and a Preprod buyer wallet holding test ADA (for fees) and test USDM.

```sh
npm install
cp .env.example .env.local   # fill in BLOCKFROST_PROJECT_ID, FRESHPROOF_BUYER_MNEMONIC, FRESHPROOF_SELLER_ADDRESS
```

Terminal demo:

```sh
npm run buy -- ETH --window 10             # real x402 payment on Preprod → APPROVE, seller paid
npm run buy -- ETH --window 0.000001       # impossible promise → REJECT, never charged
npm run buy -- ETH --window 10 --simulate  # offline mock, no wallet needed
```

Marketplace server (measures real data age from the latest Coinbase trade):

```sh
npm run market                             # http://localhost:4021/v1/price?asset=ETH&maxAge=10&price=0.1
```

Web demo:

```sh
npm run dev                                # http://localhost:3000
```

Never commit `.env.local`: it holds the buyer wallet's mnemonic.

## Status and limits

- **Real on Preprod:**
  - the x402 payment: signed by the buyer, verified by the facilitator, broadcast only on APPROVE;
  - the on-chain lookup and the balance check.
- **Measured vs. generated data age:** `market.mjs` measures age from the real trade timestamp. In `buy.mjs`'s standalone real mode the data age is generated for the demo, and the payment is real.
- **Simulated:** the web UI and the `--simulate` CLI mode show the Masumi escrow version of the flow (fund → submit → verdict → release or refund) with mock hashes.
- **Next step:** move the hold-and-check into Masumi escrow, so the freshness verdict also lives on chain.

## Also in this repo

[`agents/`](agents/) contains a Sokosumi Coworker that writes token due-diligence briefs. It buys market data from a specialist agent over x402 on Cardano Preprod (agent-to-agent payment), and handles paid Tasks through the Masumi Payment Service.
