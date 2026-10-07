#!/usr/bin/env node
// Freshproof marketplace: an x402 resource server on Cardano Preprod.
//
//   GET /v1/price?asset=ETH&maxAge=10&price=0.1
//
// 1. No PAYMENT-SIGNATURE header → 402 with the payment requirements (USDM to the seller).
// 2. Paid retry → the facilitator verifies the buyer's signed tx; it is held, not broadcast.
// 3. The marketplace fetches the latest trade and measures its age at delivery.
// 4. Fresh enough → settle (broadcast) and the seller is paid.
//    Too old    → the signed tx is dropped; the buyer's funds never move.
//
// Env: FRESHPROOF_SELLER_ADDRESS (required), BLOCKFROST_PROJECT_ID (optional, for the
// Preprod tip), FRESHPROOF_FACILITATOR_URL, FRESHPROOF_MARKET_PORT.

import http from "node:http";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import { ExactCardanoScheme } from "@x402/cardano/exact/server";
import { decodeCardanoTransaction } from "@x402/cardano";

const NETWORK = "cardano:preprod";
const PORT = Number(process.env.FRESHPROOF_MARKET_PORT || 4021);
const FACILITATOR =
  process.env.FRESHPROOF_FACILITATOR_URL || "https://x402.preprod.dev.ecosyseng.cf-deployments.org";
const SELLER = process.env.FRESHPROOF_SELLER_ADDRESS;
const BLOCKFROST = process.env.BLOCKFROST_PROJECT_ID;
const ASSETS = ["AAVE", "ETH", "BTC", "ADA", "SOL"];

if (!SELLER?.startsWith("addr_test1")) {
  console.error("Set FRESHPROOF_SELLER_ADDRESS to the seller's Preprod address (addr_test1…).");
  process.exit(1);
}

const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: FACILITATOR })).register(
  "cardano:*",
  new ExactCardanoScheme(),
);
await server.initialize();

// Latest trade from Coinbase Exchange; its timestamp is when the price was observed.
async function latestTrade(asset) {
  const res = await fetch(`https://api.exchange.coinbase.com/products/${asset}-USD/ticker`, {
    headers: { "user-agent": "freshproof-market" },
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`price source returned ${res.status}`);
  const t = await res.json();
  return { price: parseFloat(t.price), observedAt: Date.parse(t.time), tradeId: t.trade_id };
}

async function preprodTip() {
  if (!BLOCKFROST) return null;
  try {
    const res = await fetch("https://cardano-preprod.blockfrost.io/api/v0/blocks/latest", {
      headers: { project_id: BLOCKFROST },
      signal: AbortSignal.timeout(3000),
    });
    const b = await res.json();
    return { slot: b.slot, height: b.height, time: b.time * 1000 };
  } catch {
    return null;
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method !== "GET" || url.pathname !== "/v1/price") return send(res, 404, { error: "not_found" });

  const asset = (url.searchParams.get("asset") || "ETH").toUpperCase();
  const maxAge = parseFloat(url.searchParams.get("maxAge") || "10");
  const amount = parseFloat(url.searchParams.get("price") || "0.1");
  if (!ASSETS.includes(asset) || !(maxAge > 0) || !(amount > 0)) {
    return send(res, 400, { error: "bad_request", assets: ASSETS });
  }

  const requirements = await server.buildPaymentRequirementsFromOptions(
    [
      {
        scheme: "exact",
        network: NETWORK,
        payTo: SELLER,
        price: `$${amount}`, // resolves to Preprod USDM
        maxTimeoutSeconds: 300,
        extra: { confirmationPolicy: { l1Confirmations: 0 } },
      },
    ],
    {},
  );
  const resource = {
    url: url.toString(),
    description: `${asset}/USD spot price, no more than ${maxAge} s old`,
    mimeType: "application/json",
  };

  const signature = req.headers["payment-signature"];
  if (!signature) {
    const required = await server.createPaymentRequiredResponse(requirements, resource);
    return send(res, 402, required, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required) });
  }

  const payload = decodePaymentSignatureHeader(String(signature));
  const accepted = server.findMatchingRequirements(requirements, payload);
  if (!accepted) return send(res, 402, { error: "requirements_mismatch" });

  const verified = await server.verifyPayment(payload, accepted);
  if (!verified.isValid) {
    return send(res, 402, { error: verified.invalidReason, message: verified.invalidMessage });
  }
  const paymentTx = decodeCardanoTransaction(payload.payload.transaction).txHash;

  const [trade, tip] = await Promise.all([latestTrade(asset), preprodTip()]);
  const deliveredAt = Date.now();
  const age = Math.max(0, (deliveredAt - trade.observedAt) / 1000);
  const evidence = {
    asset,
    price: trade.price,
    tradeId: trade.tradeId,
    source: "coinbase-exchange",
    observedAt: trade.observedAt,
    deliveredAt,
    age,
    maxAge,
    amount,
    asset_unit: accepted.asset,
    payTo: SELLER,
    payer: verified.payer,
    paymentTx,
    tip,
  };

  if (age > maxAge) {
    console.log(`REJECT ${asset} age ${age}s > ${maxAge}s · tx ${paymentTx} dropped`);
    return send(res, 409, { verdict: "REJECT", reason: "freshness_missed", settled: false, ...evidence });
  }

  const settled = await server.settlePayment(payload, accepted);
  if (!settled.success) {
    console.log(`APPROVE ${asset} but settlement failed: ${settled.errorReason}`);
    return send(res, 502, {
      verdict: "APPROVE",
      settled: false,
      error: settled.errorReason,
      message: settled.errorMessage,
      settlementTx: settled.transaction,
      ...evidence,
    });
  }
  console.log(`APPROVE ${asset} age ${age}s ≤ ${maxAge}s · settled ${settled.transaction}`);
  send(
    res,
    200,
    { verdict: "APPROVE", settled: true, settlementTx: settled.transaction, ...evidence },
    { "PAYMENT-RESPONSE": encodePaymentResponseHeader(settled) },
  );
}

http
  .createServer((req, res) =>
    handle(req, res).catch((err) => {
      console.error(err);
      send(res, 500, { error: "internal_error", message: String(err?.message || err) });
    }),
  )
  .listen(PORT, () => {
    console.log(`Freshproof market on http://localhost:${PORT}/v1/price`);
    console.log(`  network ${NETWORK} · facilitator ${FACILITATOR}`);
    console.log(`  seller  ${SELLER}`);
  });
