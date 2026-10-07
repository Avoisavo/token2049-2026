#!/usr/bin/env node
// Freshproof terminal demo: buy the latest price with a freshness promise,
// then print a Cardano Preprod receipt.
//
//   node .claude/skills/freshproof/buy.mjs ETH --window 10 --price 0.1
//   node .claude/skills/freshproof/buy.mjs ETH --window 0.000001   # refund case
//
// Price is live from Coinbase; data age, slots and tx hashes are simulated
// unless real hashes are passed via FRESHPROOF_FUND_TX / _SUBMIT_TX / _VERDICT_TX.

import { randomBytes } from "node:crypto";

const ASSETS = {
  AAVE: { pair: "AAVE-USD", fallback: 268.4 },
  ETH: { pair: "ETH-USD", fallback: 3842.15 },
  BTC: { pair: "BTC-USD", fallback: 112480.5 },
  ADA: { pair: "ADA-USD", fallback: 0.812 },
  SOL: { pair: "SOL-USD", fallback: 214.7 },
};
const FEE_RATE = 0.02;
const SELLER = { name: "fresh-price-oracle", sla: "≤ 13 s (13 slots)" };
const EXPLORER = "https://preprod.cardanoscan.io/transaction/";
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

async function step(label, fn, ms) {
  if (tty) process.stdout.write(`  ${yellow("…")} ${label}`);
  await wait(ms);
  const detail = await fn();
  if (tty) process.stdout.write("\r\x1b[2K");
  console.log(`  ${green("✓")} ${label}${detail ? dim(" · " + detail) : ""}`);
}

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

// ---------- run ----------
const real = {
  fund: process.env.FRESHPROOF_FUND_TX,
  submit: process.env.FRESHPROOF_SUBMIT_TX,
  verdict: process.env.FRESHPROOF_VERDICT_TX,
};
const tx = { fund: real.fund || hash(), submit: real.submit || hash(), verdict: real.verdict || hash() };
const purchaseId = `pur_${hash().slice(0, 10)}`;

console.log();
console.log(bold(`Freshproof · buying latest ${assetId}/USD`) + dim(`  (Cardano Preprod · Masumi escrow)`));
console.log(dim(`  max age ${fmtLimit(windowSec)} · ${fmtAmt(amount)} USDM per query`));
console.log();

let price, live, age, observedAt, tipSlot, tipAge;

await step("request posted to seller", () => `${SELLER.name}`, 500);
await step("payment locked in escrow", () => `${fmtAmt(amount)} USDM · ${short(tx.fund)}`, 900);
await step(
  "data delivered",
  async () => {
    ({ price, live } = await fetchSpot(ASSETS[assetId]));
    const now = Date.now();
    age = windowSec < 0.001 ? 0.012 + Math.random() * 0.02 : Math.min(windowSec * 0.45, 2) + Math.random() * Math.min(windowSec * 0.4, 0.8);
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

// ---------- receipt ----------
const subSlot = windowSec < 1;
const observedSlot = slotAt(observedAt);
const behind = Math.max(0, tipSlot - observedSlot);
const link = (k) => (real[k] ? `${short(tx[k])} ${dim(EXPLORER + tx[k])}` : `${short(tx[k])}`);
const mark = passed ? green : red;

const rows = [
  ["request", `${assetId}/USD spot · ${fmtAmt(amount)} USDM · max age ${fmtLimit(windowSec)}`],
  ["fund", `${link("fund")} · ${purchaseId} · buyer agent locked ${fmtAmt(amount)} USDM in Masumi escrow`],
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
  ["submit", `${link("submit")} · the seller's wallet submitted the result hash it fetched`],
  ["verdict", `${mark(passed ? "APPROVE" : "REJECT")} · ${link("verdict")}`],
  [
    "split",
    passed
      ? `seller ${fmtAmt(amount * (1 - FEE_RATE))} · protocol fee ${fmtAmt(amount * FEE_RATE)} · total ${fmtAmt(amount)} USDM`
      : `buyer refund ${fmtAmt(amount)} · seller 0 · protocol fee 0 USDM`,
  ],
];

const W = 22;
const rule = dim("┄".repeat(78));
console.log();
console.log(blue("┃ ") + dim(`RECEIPT · ${purchaseId}`.padEnd(W + 34)) + dim("CARDANO PREPROD"));
console.log(blue("┃ ") + rule);
for (const [k, v] of rows) {
  console.log(blue("┃ ") + dim(k.padEnd(W)) + v);
  console.log(blue("┃ ") + rule);
}
console.log(
  blue("┃ ") +
    dim(
      passed
        ? `settled · the data was ${fmtAge(age)} old and you allowed ${fmtLimit(windowSec)}, so the escrow paid the seller`
        : `refunded · the data was ${fmtAge(age)} old and you allowed ${fmtLimit(windowSec)}, so the escrow refunded the buyer`,
    ),
);
console.log();
if (!real.fund) console.log(dim("  tx hashes are simulated · set FRESHPROOF_*_TX to show real Preprod transactions\n"));
