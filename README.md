# FOR (Fresh Or Refund)

**A freshness guarantee for the data AI agents buy: if the data arrives late, the money never moves. Paid with x402 on Cardano.**

Built for the TOKEN2049 Origins Hackathon, Agentic Payments on Cardano track.

---

## Intro

AI agents are becoming some of the busiest data buyers on the internet, and they buy at machine speed. A trading agent pulls a price, decides and trades within seconds. Today it pays for every query, whether the data was current or already out of date.

**FOR (Fresh Or Refund)** is a data marketplace where every purchase carries a **freshness promise that the payment itself enforces**:

- The buyer states how fresh the data must be, for example "an ETH price no more than 10 seconds old".
- The seller is paid only if the delivery keeps that promise.
- **If the data is too old, or never arrives, the payment never settles. The buyer is not charged.**

## Problem: agents pay for data they cannot use

Agentic commerce is projected to reach **$1.5 trillion a year by 2030** (Juniper Research). Bad data already costs the average organization **$12.9 million a year** (Gartner). Put the two together and you get software spending real money, at machine speed, on data that nobody guarantees.

We focus on one specific, expensive failure: **data that arrives too old to use.**

> An agent compares the Bitcoin price on two exchanges. One price is ten seconds old. By the time the agent acts, the opportunity is gone. The seller still gets paid. The buyer carries the loss.

For an agent there is no recourse. A stale API response has no refund button, no dispute window and nobody to call. At thousands of purchases a day, no human is watching either. Gartner predicts that **over 40% of agentic AI projects will be canceled by the end of 2027**, and names inadequate risk controls as one of the reasons. The payment rails for agents exist. **The recourse does not.**

## Why recourse matters

Recourse is the missing primitive of agentic commerce. Teams will not hand agents real budgets until a bad purchase can be undone automatically, by the payment itself and not by a support ticket.

- **Bounded loss.** When a broken promise means the payment never settles, the worst case per query is a failed request, not lost money. That makes an agent's data budget something a team can actually approve.
- **Freshness gets a price.** Sellers can charge more for tighter windows, and they forfeit the fee when they miss. Money flows toward faster feeds, and the premium for fresh data becomes an open, observable price instead of a private SLA.
- **No trust required.** The buyer does not have to believe "trust me, it's fresh". Delivery is checked against the promise before any money moves.

## Solution

FOR turns the freshness promise into a **condition on the payment**:

| Step | What happens |
|---|---|
| 1. Request | The buyer agent asks for a price with a maximum age (`maxAge`), e.g. ETH ≤ 10 s. |
| 2. Pay | The seller answers HTTP `402 Payment Required`. The buyer signs a USDM payment on Cardano. The x402 facilitator verifies it, and it is **held, not broadcast**. |
| 3. Deliver | The seller delivers the latest price, and its age at delivery is recorded. |
| 4. Check | **Age ≤ maxAge** → the payment is broadcast and the seller is paid on-chain (`APPROVE`). |
| 5. Void | **Age > maxAge, or nothing delivered** → the held payment is dropped (`REJECT`). The USDM never leaves the buyer's wallet, so there is nothing to claw back. |

**Both outcomes are live on Cardano Preprod.** A fresh ETH price (2.61 s old inside a 10 s window) settled 0.1 USDM to the seller in [`9d16bf3c…2810`](https://preprod.cardanoscan.io/transaction/9d16bf3c452448e2b71e965bfb1b0f63b0fbefa5c95a854dbe08ce0199212810). A request for data no older than 0.000001 s was refused. Its signed payment `acd1e1e7…097e` was never broadcast and the buyer's balance did not change.

Today the hold-and-check runs in the FOR marketplace. The next step moves the verdict into Masumi escrow on Cardano, so that the contract itself enforces the promise.

Who it is for:

- **Buyers:** teams running crypto trading agents, who need automatic checks across thousands of data purchases.
- **Sellers:** can charge more for tighter freshness promises, and earn a reputation for keeping them.
- **FOR:** earns a fee on successful transactions only.

We do not insure trading losses. We make sellers accountable for delivery. When agents spend real money, "trust me, it's fresh" should be a promise they can enforce.

## Tech stack

| Layer | Technology |
|---|---|
| Blockchain | **Cardano Preprod** testnet |
| Payment protocol | **x402** (HTTP 402), `exact` scheme on `cardano:preprod`, via [`@x402/cardano`](https://www.npmjs.com/package/@x402/cardano) and `@x402/core` |
| Facilitator | Cardano Foundation hosted Preprod facilitator, `https://x402.preprod.dev.ecosyseng.cf-deployments.org`: verifies the signed payment and broadcasts it only on settlement |
| Stablecoin | Preprod **USDM** (test USDM), paid per query (default 0.1 USDM) |
| Chain data | **Blockfrost** Preprod API: chain tip, transaction lookup, buyer balance before and after |
| Price source | Coinbase Exchange API: latest trade with its timestamp, used to measure data age |
| Marketplace + buyer agent | Node.js CLI [`.claude/skills/freshproof/buy.mjs`](.claude/skills/freshproof/buy.mjs). It runs the x402 seller side (402 offer, verify, settle only on APPROVE) and the buyer wallet that signs, then prints a receipt. Also usable as a Claude Code skill (`/freshproof`). |
| Demo UI | Next.js 16 + React 19 + Tailwind CSS 4: [`app/demo.tsx`](app/demo.tsx) |
| Escrow design | Masumi escrow flow (fund → submit result → verdict), shown in the demo UI and the `--simulate` mode |

## Transactions

Real runs of `npm run buy` on Cardano Preprod (buyer `addr_test1qzhn…ycveq0`, seller `addr_test1qpq3…a7gelc`):

| # | Run | Asset | Max age | Recorded age | Verdict | USDM moved | Tx hash | On-chain |
|---|---|---|---|---|---|---|---|---|
| 1 | Fresh delivery | ETH/USD | 10 s | 2.61 s | ✅ APPROVE, seller paid | 0.10 buyer → seller | [`9d16bf3c…2810`](https://preprod.cardanoscan.io/transaction/9d16bf3c452448e2b71e965bfb1b0f63b0fbefa5c95a854dbe08ce0199212810) | block 5,264,842 · slot 135,702,945 |
| 2 | Outdated delivery | ETH/USD | 0.000001 s | 29.4 ms | ❌ REJECT, never charged | 0 | [`acd1e1e7…097e`](https://preprod.cardanoscan.io/transaction/acd1e1e77258cb77b26ab07e621cc20177493804bc44860c5f5ccbad436e097e) | not found: never broadcast |

**Run 1, APPROVE.** The payment settled on Preprod and the buyer's tUSDM dropped by exactly the query price:

```
┃ verdict               APPROVE · payment broadcast and included on Preprod
┃ split                 seller 0.10 USDM → addr_test1qpq3…a7gelc
┃ tx hash               9d16bf3c452448e2b71e965bfb1b0f63b0fbefa5c95a854dbe08ce0199212810
┃ explorer              https://preprod.cardanoscan.io/transaction/9d16bf3c452448e2b71e965bfb1b0f63b0fbefa5c95a854dbe08ce0199212810
┃ on-chain              found on Preprod · block 5,264,842 · slot 135,702,945
┃ buyer tUSDM           1,999.70 → 1,999.60 · −0.10 paid to the seller
```

**Run 2, REJECT.** The buyer signed a real payment and the facilitator verified it. The data was 29.4 ms old against a 0.000001 s promise, so the payment was dropped instead of broadcast:

```
┃ verdict               REJECT · payment never broadcast
┃ split                 buyer charged 0 · seller 0 · 0.10 USDM never left the buyer wallet
┃ tx hash               acd1e1e77258cb77b26ab07e621cc20177493804bc44860c5f5ccbad436e097e
┃ on-chain              not found on Preprod · never broadcast
```

The REJECT hash belongs to the held payment that was dropped. Looking it up on the explorer returns "not found", and the buyer's tUSDM balance is unchanged. That is the proof the buyer was never charged.

## Proof of Cardano usage

- **Settled payment on Preprod:** https://preprod.cardanoscan.io/transaction/9d16bf3c452448e2b71e965bfb1b0f63b0fbefa5c95a854dbe08ce0199212810. It shows USDM moving from the buyer wallet to the seller address.
- **Seller address:** `addr_test1qpq347fdfms0vr7r6l6p2mlg5r4a2q04qju20y2rsy2w3577q3ymekl5k62239yyqyn6elnmn3xqyxc8ujemcj9qkddqa7gelc`
- **Buyer address:** `addr_test1qzhnpsdw63t0aj8uu6fg7svx37ndl3j3zs6nx20wgahft93d0epg8pk32wj325cam6jt8zmkxmaa3cw7ksalrg5wzsfsycveq0`
- **USDM asset:** the Preprod USDM that `@x402/cardano` resolves for `$` prices: `e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9.0014df10745553444d`
- **Receipt evidence:** each `buy.mjs` run prints the tx hash, an explorer link, the block and slot found through Blockfrost, and the buyer's tUSDM balance before and after.

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

Web demo:

```sh
npm run dev                                # http://localhost:3000
```

Never commit `.env.local`: it holds the buyer wallet's mnemonic.

## Status and limits

- **Real on Preprod:**
  - the x402 payment: signed by the buyer, verified by the facilitator, broadcast only on APPROVE;
  - the on-chain lookup and the balance check.
- **Generated data age:** in `buy.mjs` the recorded data age is generated for the demo; the price, the payment and the refund behavior are real.
- **Simulated:** the web UI and the `--simulate` CLI mode show the Masumi escrow version of the flow (fund → submit → verdict → release or refund) with mock hashes.
- **Next step:** move the hold-and-check into Masumi escrow, so the freshness verdict also lives on chain.

## Also in this repo

[`agents/`](agents/) contains a Sokosumi Coworker that writes token due-diligence briefs. It buys market data from a specialist agent over x402 on Cardano Preprod (agent-to-agent payment), and handles paid Tasks through the Masumi Payment Service.
