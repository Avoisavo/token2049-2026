#!/usr/bin/env node
// Freshproof terminal buyer: buy the latest price with a freshness promise over
// x402 on Cardano Preprod, then print the receipt.
//
//   npm run buy -- ETH --window 10              # real x402 payment (seller paid)
//   npm run buy -- ETH --window 0.000001        # freshness missed → never charged
//   npm run buy -- ETH --window 10 --simulate   # offline mock, no wallet needed
//
// Real mode: the delivered data is generated (as in the mock), but the USDM payment is
// real x402 on Preprod: the buyer signs, the hosted facilitator verifies, and the payment
// is broadcast only when the freshness check passes. Needs in .env.local:
//   FRESHPROOF_BUYER_MNEMONIC, BLOCKFROST_PROJECT_ID (Preprod), FRESHPROOF_SELLER_ADDRESS

import { randomBytes } from "node:crypto";

const ASSETS = {
  AAVE: { pair: "AAVE-USD", fallback: 268.4 },
  ETH: { pair: "ETH-USD", fallback: 3842.15 },
  BTC: { pair: "BTC-USD", fallback: 112480.5 },
  ADA: { pair: "ADA-USD", fallback: 0.812 },
  SOL: { pair: "SOL-USD", fallback: 214.7 },
};
const FEE_RATE = 0.02; // simulated mode only
const SELLER = { name: "fresh-price-oracle", sla: "≤ 13 s (13 slots)" };
const EXPLORER = "https://preprod.cardanoscan.io/transaction/";
const BLOCKFROST_URL = "https://cardano-preprod.blockfrost.io/api/v0";
const PREPROD_SLOT_OFFSET = 1655769600; // approx: Preprod slot = unix seconds − offset

// ---------- args ----------
const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
};
const positional = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
const assetId = (positional[0] || "ETH").toUpperCase();
const windowSec = parseFloat(flag("window", "10"));
const amount = parseFloat(flag("price", "0.1"));
const fast = argv.includes("--fast");
const simulate = argv.includes("--simulate");

if (!ASSETS[assetId]) {
  console.error(`Unknown asset "${assetId}". Choose one of: ${Object.keys(ASSETS).join(", ")}`);
  process.exit(1);
}
if (!(windowSec > 0) || !(amount > 0)) {
  console.error("--window and --price must be positive numbers");
  process.exit(1);
}

// ---------- output helpers ----------
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = c("2"), bold = c("1"), green = c("32"), red = c("31"), blue = c("34"), yellow = c("33");
const wait = (ms) => new Promise((r) => setTimeout(r, fast ? 0 : ms));
const hash = () => randomBytes(32).toString("hex");
const short = (h) => `${h.slice(0, 6)}…${h.slice(-4)}`;
const shortAddr = (a) => (a ? `${a.slice(0, 14)}…${a.slice(-6)}` : "unknown");
const slotAt = (ms) => Math.floor(ms / 1000) - PREPROD_SLOT_OFFSET;
const fmtSlot = (n) => n.toLocaleString("en-US");
const fmtAmt = (n) => n.toFixed(3).replace(/0$/, "");
const fmtLimit = (s) => (s >= 1 ? `${s} s` : `${s.toFixed(6)} s`);
const fmtAge = (s) =>
  s >= 1 ? `${s.toFixed(2)} s` : s >= 0.001 ? `${(s * 1000).toFixed(1)} ms` : `${(s * 1e6).toFixed(0)} µs`;
const fmtTime = (ms) => {
  const d = new Date(ms);
  return d.toLocaleTimeString("en-GB", { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0");
};
const usd = (n) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: n < 10 ? 4 : 2 });

async function step(label, fn, ms = 0) {
  if (tty) process.stdout.write(`  ${yellow("…")} ${label}`);
  await wait(ms);
  try {
    const detail = await fn();
    if (tty) process.stdout.write("\r\x1b[2K");
    console.log(`  ${green("✓")} ${label}${detail ? dim(" · " + detail) : ""}`);
  } catch (err) {
    if (tty) process.stdout.write("\r\x1b[2K");
    console.log(`  ${red("✕")} ${label}${dim(" · " + (err?.message || err))}`);
    throw err;
  }
}

function printReceipt(id, rows, finalLine) {
  const W = 22;
  const rule = dim("┄".repeat(78));
  console.log();
  console.log(blue("┃ ") + dim(`RECEIPT · ${id}`.padEnd(W + 34)) + dim("CARDANO PREPROD"));
  console.log(blue("┃ ") + rule);
  for (const [k, v] of rows) {
    console.log(blue("┃ ") + dim(k.padEnd(W)) + v);
    console.log(blue("┃ ") + rule);
  }
  console.log(blue("┃ ") + dim(finalLine));
  console.log();
}

function header(mode) {
  console.log();
  console.log(bold(`Freshproof · buying latest ${assetId}/USD`) + dim(`  (Cardano Preprod · ${mode})`));
  console.log(dim(`  max age ${fmtLimit(windowSec)} · ${fmtAmt(amount)} USDM per query`));
  console.log();
}

// =====================================================================
// Real mode: x402 on Cardano Preprod
// =====================================================================

const FACILITATOR =
  process.env.FRESHPROOF_FACILITATOR_URL || "https://x402.preprod.dev.ecosyseng.cf-deployments.org";

const withTimeout = (p, ms, what) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000}s`)), ms))]);

async function preprodTip(projectId) {
  try {
    const res = await fetch(`${BLOCKFROST_URL}/blocks/latest`, {
      headers: { project_id: projectId },
      signal: AbortSignal.timeout(3000),
    });
    const b = await res.json();
    if (Number.isFinite(b.slot)) return { slot: b.slot, time: b.time * 1000 };
  } catch {}
  return { slot: slotAt(Date.now()), time: Date.now() };
}

async function blockfrost(path, projectId) {
  const res = await fetch(`${BLOCKFROST_URL}${path}`, {
    headers: { project_id: projectId },
    signal: AbortSignal.timeout(5000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`blockfrost ${res.status}`);
  return res.json();
}

async function tokenBalance(address, unit, projectId) {
  try {
    const a = await blockfrost(`/addresses/${address}`, projectId);
    const q = a?.amount?.find((x) => x.unit === unit)?.quantity ?? "0";
    return Number(q) / 1e6;
  } catch {
    return null;
  }
}

async function onChain(txHash, projectId) {
  try {
    const tx = await blockfrost(`/txs/${txHash}`, projectId);
    return tx ? { found: true, block: tx.block_height, slot: tx.slot } : { found: false };
  } catch {
    return null;
  }
}

async function runReal() {
  const mnemonic = process.env.FRESHPROOF_BUYER_MNEMONIC;
  const projectId = process.env.BLOCKFROST_PROJECT_ID;
  const payTo = process.env.FRESHPROOF_SELLER_ADDRESS;
  if (!mnemonic || !projectId || !payTo) {
    console.error(
      [
        "Real x402 mode needs these in .env.local:",
        "  FRESHPROOF_BUYER_MNEMONIC=…   (Preprod wallet holding tADA + tUSDM)",
        "  BLOCKFROST_PROJECT_ID=preprod…",
        "  FRESHPROOF_SELLER_ADDRESS=addr_test1…",
        "Or run with --simulate for the offline mock.",
      ].join("\n"),
    );
    process.exit(1);
  }

  const { x402ResourceServer, HTTPFacilitatorClient } = await import("@x402/core/server");
  const { x402Client } = await import("@x402/core/client");
  const { ExactCardanoScheme: ServerScheme } = await import("@x402/cardano/exact/server");
  const { ExactCardanoScheme: ClientScheme } = await import("@x402/cardano/exact/client");
  const { toClientCardanoSigner, decodeCardanoTransaction } = await import("@x402/cardano");

  // Marketplace side: x402 resource server backed by the hosted Preprod facilitator.
  const market = new x402ResourceServer(new HTTPFacilitatorClient({ url: FACILITATOR })).register(
    "cardano:*",
    new ServerScheme(),
  );
  // Buyer side: signs USDM payments with the buyer wallet.
  const buyer = new x402Client().register(
    "cardano:*",
    new ClientScheme(
      toClientCardanoSigner({
        mnemonic,
        network: "cardano:preprod",
        provider: { blockfrost: { baseUrl: BLOCKFROST_URL, projectId }, requestTimeoutMs: 30000 },
      }),
    ),
  );

  header("x402 · USDM");

  let required, requirements, payload, paymentTx, payer;
  let price, live, age, observedAt, tip, settlement, usdmUnit, balanceBefore;

  await step("request posted to seller", async () => {
    await withTimeout(market.initialize(), 15000, "facilitator");
    requirements = await market.buildPaymentRequirementsFromOptions(
      [
        {
          scheme: "exact",
          network: "cardano:preprod",
          payTo,
          price: `$${amount}`, // resolves to Preprod USDM
          maxTimeoutSeconds: 300,
          extra: { confirmationPolicy: { l1Confirmations: 0 } },
        },
      ],
      {},
    );
    required = await market.createPaymentRequiredResponse(requirements, {
      url: `freshproof://${SELLER.name}/v1/price?asset=${assetId}&maxAge=${windowSec}`,
      description: `${assetId}/USD spot price, no more than ${windowSec} s old`,
      mimeType: "application/json",
    });
    return `${SELLER.name} · 402 Payment Required · ${fmtAmt(amount)} USDM`;
  });

  await step("payment signed by buyer wallet", async () => {
    payload = await withTimeout(buyer.createPaymentPayload(required), 45000, "signing");
    paymentTx = decodeCardanoTransaction(payload.payload.transaction).txHash;
    return `${fmtAmt(amount)} USDM · ${short(paymentTx)} · held, not broadcast`;
  });

  await step("payment verified by x402 facilitator", async () => {
    const v = await withTimeout(market.verifyPayment(payload, requirements[0]), 30000, "verification");
    if (!v.isValid) throw new Error(`${v.invalidReason} ${v.invalidMessage || ""}`);
    payer = v.payer;
    usdmUnit = requirements[0].asset.replace(".", "");
    balanceBefore = await tokenBalance(payer, usdmUnit, projectId);
    return `payer ${shortAddr(payer)}`;
  });

  await step(
    "data delivered",
    async () => {
      [{ price, live }, tip] = await Promise.all([fetchSpot(ASSETS[assetId]), preprodTip(projectId)]);
      const now = Date.now();
      age =
        windowSec < 0.001
          ? 0.012 + Math.random() * 0.02
          : Math.min(windowSec * 0.45, 2) + Math.random() * Math.min(windowSec * 0.4, 0.8);
      observedAt = now - age * 1000;
      return `${usd(price)} · age ${fmtAge(age)}`;
    },
    500,
  );

  const passed = age <= windowSec;
  await step("freshness check", () => `${fmtAge(age)} ${passed ? "≤" : ">"} ${fmtLimit(windowSec)}`, 700);

  if (passed) {
    await step("payment broadcast · waiting for a Preprod block", async () => {
      settlement = await withTimeout(market.settlePayment(payload, requirements[0]), 180000, "settlement");
      if (!settlement.success) throw new Error(`${settlement.errorReason} ${settlement.errorMessage || ""}`);
      return `${short(settlement.transaction)} · seller paid`;
    });
  } else {
    await step("payment voided", () => "signed tx dropped · buyer never charged", 400);
  }

  // Preprod slots are 1 s, so slots follow wall-clock time from the last block.
  const slotOf = (ms) => tip.slot + Math.floor((ms - tip.time) / 1000);
  const blockAge = Math.max(0, (Date.now() - tip.time) / 1000);
  const subSlot = windowSec < 1;
  const observedSlot = slotOf(observedAt);
  const deliveredSlot = slotOf(observedAt + age * 1000);
  const behind = deliveredSlot - observedSlot;
  const mark = passed ? green : red;
  const link = (h) => `${short(h)}`;

  const rows = [
    ["request", `${assetId}/USD spot · ${fmtAmt(amount)} USDM · max age ${fmtLimit(windowSec)}`],
    [
      "fund",
      `${link(paymentTx)} · buyer ${shortAddr(payer)} signed ${fmtAmt(amount)} USDM · verified by the x402 facilitator, held until the check`,
    ],
    ["result", bold(`${assetId}/USD ${usd(price)}`) + (live ? "" : dim(" (offline fallback)"))],
    ["delivered", `observed at slot ${fmtSlot(observedSlot)} · ${fmtTime(observedAt)} · signed by ${SELLER.name}`],
    [
      "data age at delivery",
      subSlot
        ? `${fmtAge(age)} · inside slot ${fmtSlot(deliveredSlot)}; the last Preprod block (slot ${fmtSlot(tip.slot)}) is ${blockAge.toFixed(1)} s old`
        : `${fmtAge(age)} · observed ${behind} slot${behind === 1 ? "" : "s"} before delivery at slot ${fmtSlot(deliveredSlot)}; the last Preprod block (slot ${fmtSlot(tip.slot)}) is ${blockAge.toFixed(1)} s old`,
    ],
    ["your window", `${fmtLimit(windowSec)} · the seller promises ${SELLER.sla}`],
    [
      "sla floor",
      mark(
        subSlot
          ? `observed within ${fmtLimit(windowSec)} of delivery · the delivery ${passed ? "clears it" : `misses it by ${fmtAge(age - windowSec)}`}`
          : `slot ${fmtSlot(deliveredSlot - Math.round(windowSec))} · the delivery ${passed ? "clears it" : "misses it"}`,
      ),
    ],
    [
      "verdict",
      passed
        ? `${mark("APPROVE")} · payment broadcast and included on Preprod`
        : `${mark("REJECT")} · payment never broadcast`,
    ],
    [
      "split",
      passed
        ? `seller ${fmtAmt(amount)} USDM → ${shortAddr(payTo)}`
        : `buyer charged 0 · seller 0 · ${fmtAmt(amount)} USDM never left the buyer wallet`,
    ],
  ];

  // Proof: look the tx up on Preprod and compare the buyer's tUSDM balance.
  let chain = await onChain(paymentTx, projectId);
  let balanceAfter = await tokenBalance(payer, usdmUnit, projectId);
  for (let i = 0; passed && i < 10 && (!chain?.found || balanceAfter === balanceBefore); i++) {
    await new Promise((r) => setTimeout(r, 2000)); // indexer lag
    [chain, balanceAfter] = await Promise.all([onChain(paymentTx, projectId), tokenBalance(payer, usdmUnit, projectId)]);
  }
  const fmtBal = (b) => (b === null ? "?" : b.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 }));
  rows.push(
    ["tx hash", bold(paymentTx)],
    ["explorer", `${EXPLORER}${paymentTx}`],
    [
      "on-chain",
      chain === null
        ? dim("lookup failed")
        : chain.found
          ? green(`found on Preprod · block ${fmtSlot(chain.block)} · slot ${fmtSlot(chain.slot)}`)
          : (passed ? red : green)(`not found on Preprod · ${passed ? "still indexing" : "never broadcast"}`),
    ],
    [
      "buyer tUSDM",
      `${fmtBal(balanceBefore)} → ${fmtBal(balanceAfter)}` +
        dim(
          balanceBefore !== null && balanceAfter !== null && balanceBefore === balanceAfter
            ? " · unchanged"
            : ` · −${fmtAmt(amount)} paid to the seller`,
        ),
    ],
  );

  printReceipt(
    `x402 · ${short(paymentTx)}`,
    rows,
    passed
      ? `settled · the data was ${fmtAge(age)} old and you allowed ${fmtLimit(windowSec)}, so the seller was paid on-chain`
      : `voided · the data was ${fmtAge(age)} old and you allowed ${fmtLimit(windowSec)}, so the payment was never broadcast`,
  );
}

// =====================================================================
// Simulated mode (offline mock, no wallet)
// =====================================================================

async function fetchSpot({ pair, fallback }) {
  try {
    const res = await fetch(`https://api.coinbase.com/v2/prices/${pair}/spot`, {
      signal: AbortSignal.timeout(2000),
    });
    const p = parseFloat((await res.json())?.data?.amount);
    if (Number.isFinite(p)) return { price: p, live: true };
  } catch {}
  return { price: fallback * (1 + (Math.random() - 0.5) * 0.002), live: false };
}

async function runSimulated() {
  const tx = { fund: hash(), submit: hash(), verdict: hash() };
  const purchaseId = `pur_${hash().slice(0, 10)}`;
  header("simulated · Masumi escrow");

  let price, live, age, observedAt, tipSlot, tipAge;

  await step("request posted to seller", () => `${SELLER.name}`, 500);
  await step("payment locked in escrow", () => `${fmtAmt(amount)} USDM · ${short(tx.fund)}`, 900);
  await step(
    "data delivered",
    async () => {
      ({ price, live } = await fetchSpot(ASSETS[assetId]));
      const now = Date.now();
      age =
        windowSec < 0.001
          ? 0.012 + Math.random() * 0.02
          : Math.min(windowSec * 0.45, 2) + Math.random() * Math.min(windowSec * 0.4, 0.8);
      observedAt = now - age * 1000;
      tipAge = 0.2 + Math.random() * 0.7;
      tipSlot = slotAt(now - tipAge * 1000);
      return `${usd(price)} · age ${fmtAge(age)}`;
    },
    700,
  );
  await step("seller submitted result on-chain", () => short(tx.submit), 800);
  const passed = age <= windowSec;
  await step("freshness check", () => `${fmtAge(age)} ${passed ? "≤" : ">"} ${fmtLimit(windowSec)}`, 900);
  await step("escrow settled", () => (passed ? "released to seller" : "refunded to buyer"), 700);

  const subSlot = windowSec < 1;
  const observedSlot = slotAt(observedAt);
  const behind = Math.max(0, tipSlot - observedSlot);
  const mark = passed ? green : red;

  const rows = [
    ["request", `${assetId}/USD spot · ${fmtAmt(amount)} USDM · max age ${fmtLimit(windowSec)}`],
    ["fund", `${short(tx.fund)} · ${purchaseId} · buyer agent locked ${fmtAmt(amount)} USDM in Masumi escrow`],
    ["result", bold(`${assetId}/USD ${usd(price)}`) + (live ? "" : dim(" (offline fallback)"))],
    ["delivered", `observed at slot ${fmtSlot(observedSlot)} · ${fmtTime(observedAt)} · signed by ${SELLER.name}`],
    [
      "data age at delivery",
      subSlot
        ? `${fmtAge(age)} · inside the current slot; the Preprod tip ${fmtSlot(tipSlot)} is itself ${tipAge.toFixed(1)} s old`
        : `${fmtAge(age)} · observed ${behind} slot${behind === 1 ? "" : "s"} behind the Preprod tip ${fmtSlot(tipSlot)}, which is itself ${tipAge.toFixed(1)} s old`,
    ],
    ["your window", `${fmtLimit(windowSec)} · the seller promises ${SELLER.sla}`],
    [
      "sla floor",
      mark(
        subSlot
          ? `observed within ${fmtLimit(windowSec)} of delivery · the delivery ${passed ? "clears it" : `misses it by ${fmtAge(age - windowSec)}`}`
          : `slot ${fmtSlot(tipSlot - Math.round(windowSec))} · the delivery ${passed ? "clears it" : "misses it"}`,
      ),
    ],
    ["submit", `${short(tx.submit)} · the seller's wallet submitted the result hash it fetched`],
    ["verdict", `${mark(passed ? "APPROVE" : "REJECT")} · ${short(tx.verdict)}`],
    [
      "split",
      passed
        ? `seller ${fmtAmt(amount * (1 - FEE_RATE))} · protocol fee ${fmtAmt(amount * FEE_RATE)} · total ${fmtAmt(amount)} USDM`
        : `buyer refund ${fmtAmt(amount)} · seller 0 · protocol fee 0 USDM`,
    ],
  ];

  printReceipt(
    purchaseId,
    rows,
    passed
      ? `settled · the data was ${fmtAge(age)} old and you allowed ${fmtLimit(windowSec)}, so the escrow paid the seller`
      : `refunded · the data was ${fmtAge(age)} old and you allowed ${fmtLimit(windowSec)}, so the escrow refunded the buyer`,
  );
  console.log(dim("  simulated run · tx hashes are not on-chain\n"));
}

try {
  await (simulate ? runSimulated() : runReal());
} catch (err) {
  console.error(red(`\n  ${err?.message || err}\n`));
  process.exit(1);
}
