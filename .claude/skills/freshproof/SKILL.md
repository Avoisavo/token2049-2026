---
name: freshproof
description: Buy the latest crypto price (ETH, BTC, ADA, SOL, AAVE) through the Freshproof data marketplace with an enforceable freshness promise, paid with x402 on Cardano Preprod, and show the receipt in the terminal. Use when the user asks to buy/get the latest price with a freshness window, runs /freshproof, or wants the paid (APPROVE) or voided (REJECT) demo in the command line.
argument-hint: "[ASSET] [--window SECONDS] [--price USDM] [--simulate]"
---

# Freshproof: buy fresh data over x402 from the terminal

`buy.mjs` runs the whole flow in one process. The delivered data and its age are generated, as in the mock. The USDM payment is real x402 on Cardano Preprod:
- the buyer wallet signs a payment to the seller
- the hosted x402 facilitator verifies it
- the payment is broadcast only if the freshness check passes; otherwise the signed tx is dropped

## Run

```bash
npm run buy -- $ARGUMENTS
```

Defaults: `ETH --window 10 --price 0.1`. The script reads `.env.local`, which needs `FRESHPROOF_BUYER_MNEMONIC`, `BLOCKFROST_PROJECT_ID` and `FRESHPROOF_SELLER_ADDRESS`.

Map natural language to flags:
- asset: `AAVE`, `ETH`, `BTC`, `ADA`, `SOL` (first positional argument)
- "no more than N seconds old" → `--window N`
- "impossible freshness", "refund demo", or "0.000001 s" → `--window 0.000001`, which always fails, so the payment is never broadcast
- query price in USDM → `--price N` (the client caps a single payment at $1 by default)
- "simulate", "offline", or no wallet configured → add `--simulate`

If the script says real mode needs a wallet, show the user its setup message. Never read, print or echo `.env.local` or the mnemonic.

## After it runs

Bash output is not reliably shown to the user, so reproduce the result in your reply:

1. The progress lines (✓ / ✕), as a short list.
2. The whole receipt, from `request` to the final line, inside one fenced code block, exactly as printed.
3. One sentence on the outcome:
   - APPROVE: the tx is on Preprod. Point to the receipt's `on-chain` row and the tUSDM balance drop, and give the explorer link.
   - REJECT: the signed payment was never broadcast. The `on-chain` row says "not found" and the buyer's tUSDM is unchanged.

A settlement can take up to about a minute, because the facilitator waits for the tx to be included in a block.
