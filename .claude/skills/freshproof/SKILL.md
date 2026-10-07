---
name: freshproof
description: Buy the latest crypto price (ETH, BTC, ADA, SOL, AAVE) through the Freshproof data marketplace with an enforceable freshness promise, paid with x402 on Cardano Preprod, and show the receipt in the terminal. Use when the user asks to buy/get the latest price with a freshness window, runs /freshproof, or wants the paid (APPROVE) or voided (REJECT) demo in the command line.
argument-hint: "[ASSET] [--window SECONDS] [--price USDM] [--simulate]"
---

# Freshproof: buy fresh data over x402 from the terminal

Two pieces:
- `market.mjs`: the marketplace. It's an x402 resource server: it returns 402, verifies the buyer's signed USDM payment through the hosted Preprod facilitator, checks freshness, and broadcasts the payment only if the check passes.
- `buy.mjs`: the buyer. It signs the payment with the buyer wallet and prints the receipt.

## Run

1. Check the marketplace is up: `curl -s -o /dev/null -w "%{http_code}" "http://localhost:4021/v1/price"` should print `402`. If it doesn't, start it in the background with `npm run market` (it reads `.env.local`).
2. Run the buyer (default `ETH --window 10 --price 0.1`):

```bash
npm run buy -- $ARGUMENTS
```

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
   - APPROVE: the settlement tx is real on Preprod. Give the explorer link the script printed.
   - REJECT: the signed payment was never broadcast, so the buyer was never charged.

A settlement can take up to about a minute, because the facilitator waits for the tx to be included in a block.
