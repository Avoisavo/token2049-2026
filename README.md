# Token Due-Diligence Coworker (x402 agent-to-agent payments on Cardano)

A Sokosumi Coworker that writes sourced due-diligence briefs on crypto tokens. To do the work it **hires another agent**: it buys market data from a specialist data agent and pays it over **x402** on Cardano preprod, from its own wallet.

Two payments, two protocols, one Task:

```
Sokosumi buyer ──1 tUSDM, Masumi escrow (MPS)──▶ Due-diligence Coworker
                                                     │ GET /v1/token-profile → 402
                                                     │ signs 0.10 tUSDM, x402 "exact"
                                                     ▼
                                               Specialist data agent ──▶ CoinGecko data + sources
                                                     │
                     Claude writes the brief ◀───────┘
Coworker submits result hash → completes Task → seller collects after unlock
```

| Part | File | Role |
|---|---|---|
| Specialist data agent | [agents/specialist/server.ts](agents/specialist/server.ts) | x402 resource server. One token profile per payment, verified and settled by the hosted Cardano Foundation facilitator. A 4xx (unknown token, bad query) cancels settlement, so the buyer is not charged. |
| x402 buyer | [agents/coworker/x402-buyer.ts](agents/coworker/x402-buyer.ts) | The Coworker's wallet. Saves the signed payment **before** sending it; after a crash it resends the same signed transaction. It signs a new one only after the old one has expired and is absent on chain. Spend cap 0.25 tUSDM. |
| Brief writer | [agents/coworker/brief.ts](agents/coworker/brief.ts) | Claude (`claude-opus-5-5`) extracts the request, then writes the brief from the purchased data only, citing sources and listing gaps. |
| Job | [agents/coworker/job.ts](agents/coworker/job.ts) | Request → purchase → brief. Each step is journaled, so a restart never pays or prompts twice. |
| Worker | [agents/coworker/worker.ts](agents/coworker/worker.ts) | Polls Sokosumi Tasks for this Coworker. One worker per Coworker (lock file). |
| Paid Task | [agents/coworker/paid-task.ts](agents/coworker/paid-task.ts), [settlement.ts](agents/coworker/settlement.ts) | MPS escrow flow: signed terms → `masumiPayment` → confirmed `FundsLocked` → job → result hash → completion → independent proof of seller collection. Ported from Masumi's verified demo. |

## Run it

Requirements: Node 24+, the Sokosumi CLI (`npm i -g @masumi_network/sokosumi`), a Blockfrost **preprod** project key, and an Anthropic API key.

```sh
npm install
npm run wallets          # creates two preprod test wallets in .env.local, prints addresses
```

Add `BLOCKFROST_API_KEY_PREPROD` and `ANTHROPIC_API_KEY` to `.env.local` (see [.env.example](.env.example)). Fund the **buyer** wallet with test ADA and Masumi test USDM (policy `16a55b2a…`) from https://dispenser.masumi.network, and the **specialist** wallet with a little test ADA. Then:

```sh
npm run specialist                                       # terminal 1
npm run job -- "Due diligence on SNEK for our treasury team"   # terminal 2: one local job, real x402 payment
```

Connect it to Sokosumi (see the [TOKEN2049 guide](https://www.masumi.network/token2049)), put `COWORKER_ID` in `.env.local`, then:

```sh
npm run worker
```

Paid Tasks: run the Masumi Payment Service, register the agent with `{"pricingType":"Dynamic"}`, save the registration to `.local/mps-registration.json`, set `MPS_RUNTIME_TOKEN` and `PAID_TASKS_ENABLED=true`.

Checks: `npm run typecheck:agents`.

## Status

Verified on 2026-10-07:

- The specialist answers an unpaid request with HTTP 402 and a valid x402 v2 offer (`exact`, `cardano:preprod`, 100000 units of Masumi tUSDM).
- The hosted facilitator advertises `exact` on preprod.
- The data lookup returns sourced CoinGecko figures, and `found: false` for unknown tokens.
- The agents code typechecks.

Not yet run: a funded x402 payment, a Claude call, a Sokosumi Task, MPS registration, and a paid Task with seller collection. Those need the keys, funding and accounts above.

State, results and keys live in `.local/` and `.env.local`, both git-ignored. Never commit them.
