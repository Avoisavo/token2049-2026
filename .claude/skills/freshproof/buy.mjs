#!/usr/bin/env node
// Freshproof terminal buyer: buy the latest price with a freshness promise over
// x402 on Cardano Preprod, then print the receipt.
//
//   npm run buy -- ETH --window 10              # real x402 payment (seller paid)
//   npm run buy -- ETH --window 0.000001        # freshness missed → never charged
//   npm run buy -- ETH --window 10 --simulate   # offline mock, no wallet needed
//
// Real mode needs the marketplace running (`npm run market`) and, in .env.local:
//   FRESHPROOF_BUYER_MNEMONIC, BLOCKFROST_PROJECT_ID (Preprod), FRESHPROOF_MARKET_URL (optional)

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
const MARKET = process.env.FRESHPROOF_MARKET_URL || "http://localhost:4021";
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

async function runReal() {
  const mnemonic = process.env.FRESHPROOF_BUYER_MNEMONIC;
  const projectId = process.env.BLOCKFROST_PROJECT_ID;
  if (!mnemonic || !projectId) {
    console.error(
      [
        "Real x402 mode needs a funded Preprod buyer wallet. Add to .env.local:",
        "  FRESHPROOF_BUYER_MNEMONIC=…   (24 words; wallet holds tADA + tUSDM)",
        "  BLOCKFROST_PROJECT_ID=preprod…",
        "  FRESHPROOF_SELLER_ADDRESS=addr_test1…   (for the market server)",
        "Then start the market with `npm run market` in another terminal.",
        "Or run with --simulate for the offline mock.",
      ].join("\n"),
    );
    process.exit(1);
  }

  const { x402Client, x402HTTPClient } = await import("@x402/core/client");
  const { ExactCardanoScheme } = await import("@x402/cardano/exact/client");
  const { toClientCardanoSigner, decodeCardanoTransaction } = await import("@x402/cardano");

  const signer = toClientCardanoSigner({
    mnemonic,
    network: "cardano:preprod",
    provider: { blockfrost: { baseUrl: BLOCKFROST_URL, projectId }, requestTimeoutMs: 30000 },
  });
  const client = new x402HTTPClient(new x402Client().register("cardano:*", new ExactCardanoScheme(signer)));
  const url = `${MARKET}/v1/price?asset=${assetId}&maxAge=${windowSec}&price=${amount}`;

  header("x402 · USDM");

  let required, payload, paymentTx, res, body;

  await step("request posted to marketplace", async () => {
    const r = await fetch(url).catch(() => {
      throw new Error(`marketplace not reachable at ${MARKET} — run \`npm run market\``);
    });
    if (r.status !== 402) throw new Error(`expected 402, got ${r.status}`);
    required = client.getPaymentRequiredResponse((n) => r.headers.get(n), await r.json());
    const a = required.accepts[0];
    return `402 Payment Required · ${Number(a.amount) / 1e6} USDM to ${shortAddr(a.payTo)}`;
  });

  await step("payment signed by buyer wallet", async () => {
    payload = await client.createPaymentPayload(required);
    paymentTx = decodeCardanoTransaction(payload.payload.transaction).txHash;
    return `${short(paymentTx)} · held, not broadcast`;
  });

  await step("marketplace verifying payment, fetching data, checking freshness", async () => {
    res = await fetch(url, { headers: client.encodePaymentSignatureHeader(payload) });
    body = await res.json();
    if (res.status === 402) throw new Error(`payment rejected: ${body.error} ${body.message || ""}`);
    if (!body.verdict) throw new Error(`${res.status} ${body.error || ""} ${body.message || ""}`);
    return `HTTP ${res.status}`;
  });

  const passed = body.verdict === "APPROVE";
  console.log(`  ${green("✓")} data delivered${dim(` · ${usd(body.price)} · age ${fmtAge(body.age)}`)}`);
  console.log(
    `  ${passed ? green("✓") : red("✕")} freshness check${dim(` · ${fmtAge(body.age)} ${passed ? "≤" : ">"} ${fmtLimit(windowSec)}`)}`,
  );
  if (passed && body.settled) {
    console.log(`  ${green("✓")} settled on-chain${dim(` · ${short(body.settlementTx)} · seller paid`)}`);
  } else if (passed) {
    console.log(`  ${red("✕")} settlement failed${dim(` · ${body.error}`)}`);
  } else {
    console.log(`  ${green("✓")} payment voided${dim(" · signed tx dropped, buyer never charged")}`);
  }

  const tip = body.tip;
  const floor = body.deliveredAt - windowSec * 1000;
  const mark = passed ? green : red;
  const rows = [
    ["request", `${assetId}/USD spot · ${fmtAmt(amount)} USDM · max age ${fmtLimit(windowSec)}`],
    [
      "payment",
      `${short(paymentTx)} · signed by buyer ${shortAddr(body.payer)} · verified by the x402 facilitator, held unbroadcast`,
    ],
    ["result", bold(`${assetId}/USD ${usd(body.price)}`) + dim(` · coinbase trade #${body.tradeId}`)],
    ["delivered", `last trade ${fmtTime(body.observedAt)} · served ${fmtTime(body.deliveredAt)} by the marketplace`],
    [
      "data age at delivery",
      `${fmtAge(body.age)}` +
        (tip ? ` · Preprod tip slot ${fmtSlot(tip.slot)} (block ${fmtSlot(tip.height)})` : ""),
    ],
    ["your window", `${fmtLimit(windowSec)} · enforced before the payment is broadcast`],
    [
      "sla floor",
      mark(
        `trade after ${fmtTime(floor)} · the delivery ${passed ? "clears it" : `misses it by ${fmtAge(body.age - windowSec)}`}`,
      ),
    ],
    [
      "verdict",
      passed
        ? `${mark("APPROVE")} · ${body.settled ? short(body.settlementTx) : "settlement failed: " + body.error}`
        : `${mark("REJECT")} · payment ${short(paymentTx)} never broadcast`,
    ],
    [
      "split",
      passed
        ? `seller ${fmtAmt(amount)} USDM → ${shortAddr(body.payTo)}`
        : `buyer charged 0 · seller 0 · ${fmtAmt(amount)} USDM never left the buyer wallet`,
    ],
  ];

  printReceipt(
    `x402 · ${short(paymentTx)}`,
    rows,
    passed
      ? body.settled
        ? `settled · the data was ${fmtAge(body.age)} old and you allowed ${fmtLimit(windowSec)}, so the seller was paid on-chain`
        : `approved but not settled · ${body.message || body.error}`
      : `voided · the data was ${fmtAge(body.age)} old and you allowed ${fmtLimit(windowSec)}, so the payment was never broadcast`,
  );
  if (passed && body.settled) console.log(`  ${dim("explorer")} ${EXPLORER}${body.settlementTx}\n`);
  else if (!passed) console.log(dim(`  ${EXPLORER}${paymentTx}  (not found: it never reached the chain)\n`));
  if (passed && !body.settled) process.exit(1);
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
