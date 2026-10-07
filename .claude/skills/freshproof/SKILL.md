---
name: freshproof
description: Buy the latest crypto price (ETH, BTC, ADA, SOL, AAVE) through the Freshproof data marketplace with an enforceable freshness promise, and show the Cardano Preprod receipt in the terminal. Use when the user asks to buy/get the latest price with a freshness window, runs /freshproof, or wants the paid (APPROVE) or refund (REJECT) demo in the command line.
argument-hint: "[ASSET] [--window SECONDS] [--price USDM]"
---

# Freshproof: buy fresh data from the terminal

Run the bundled script with the user's arguments (default `ETH --window 10 --price 0.1`):

```bash
node .claude/skills/freshproof/buy.mjs $ARGUMENTS
```

Map natural language to flags:
- asset: `AAVE`, `ETH`, `BTC`, `ADA`, `SOL` (first positional argument)
- "no more than N seconds old" → `--window N`
- "impossible freshness", "refund demo", or "0.000001 s" → `--window 0.000001`, which always fails and refunds the buyer
- query price in USDM → `--price N`

## After it runs

Bash output is not reliably shown to the user, so reproduce the result in your reply:

1. The progress lines (✓ request posted … ✓ escrow settled), as a short list.
2. The whole receipt (every row from `request` to the final `settled` / `refunded` line) inside one fenced code block, exactly as printed.
3. One sentence on the outcome: APPROVE means the seller was paid minus the 2% protocol fee. REJECT means the buyer got a full refund.

Say that the tx hashes are simulated unless the script printed explorer links. The price comes from Coinbase's live spot API, unless the result line says "offline fallback".

To show real Preprod transactions, set `FRESHPROOF_FUND_TX`, `FRESHPROOF_SUBMIT_TX` and `FRESHPROOF_VERDICT_TX` before running.
