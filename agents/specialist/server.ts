// Specialist data agent: sells one token profile per x402 payment on Cardano preprod.
// Payment: exact scheme, 0.10 Masumi test USDM, paid directly to the specialist wallet.
// The hosted Cardano Foundation facilitator verifies and broadcasts; this
// process holds no buyer keys and never builds transactions.
import { createHash } from "node:crypto";
import express from "express";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import type { HTTPTransportContext, RoutesConfig, VerifyContext } from "@x402/core/server";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { paymentMiddleware } from "@x402/express";
import { ExactCardanoScheme } from "@x402/cardano/exact/server";
import { decodeCardanoTransaction } from "@x402/cardano";
import { addressOf, HOSTED_FACILITATOR_URL, MASUMI_USDM_X402_ASSET, NETWORK, optional, required } from "../lib/config.ts";
import { Journal } from "../lib/journal.ts";
import { lookupToken } from "./data.ts";

const PRICE_UNITS = optional("SPECIALIST_PRICE_UNITS", "100000"); // 0.10 tUSDM
const PORT = Number(optional("SPECIALIST_PORT", "4021"));
const ROUTE = "/v1/token-profile";

// The specialist only needs a receiving address; derive it from its own wallet.
const payTo = addressOf(required("SPECIALIST_MNEMONIC"));

// One record per payment transaction: the verified payload fingerprint and the
// response body it bought. A buyer resuming the same signed payment gets the
// same body and settlement resumes instead of failing fresh verification
// (its inputs are already spent once the facilitator has broadcast it).
interface Sale {
  operation: string;
  fingerprint: string;
  verify?: unknown;
  status?: number;
  body?: unknown;
}
const sales = new Journal<Sale>("specialist-sales");

function identify(context: VerifyContext) {
  const request = (context.transportContext as HTTPTransportContext).request;
  const url = new URL(request.adapter.getUrl());
  const tx = decodeCardanoTransaction(String(context.paymentPayload.payload.transaction));
  const fingerprint = createHash("sha256").update(JSON.stringify([context.paymentPayload, context.requirements])).digest("hex");
  return { txHash: tx.txHash, operation: `${request.method} ${url.pathname}?${url.searchParams}`, fingerprint };
}

const facilitator = new HTTPFacilitatorClient({ url: optional("FACILITATOR_URL", HOSTED_FACILITATOR_URL), timeoutMs: 120_000 });
const resourceServer = new x402ResourceServer(facilitator).register(NETWORK, new ExactCardanoScheme());

resourceServer.onBeforeVerify(async context => {
  try {
    const { txHash, fingerprint } = identify(context);
    const sale = sales.get(txHash);
    if (sale?.verify && sale.fingerprint === fingerprint) return { skip: true as const, result: sale.verify as never };
  } catch {
    // Malformed payload: let the official verifier explain it.
  }
});
resourceServer.onAfterVerify(async context => {
  if (!context.result.isValid) {
    console.warn(`[verify] ${context.result.invalidReason ?? "invalid"} ${context.result.invalidMessage ?? ""}`);
    return;
  }
  try {
    const { txHash, operation, fingerprint } = identify(context);
    const sale = sales.get(txHash);
    // One transaction buys exactly one request; it cannot be replayed for another query.
    if (sale && (sale.operation !== operation || sale.fingerprint !== fingerprint)) {
      return { abort: true as const, reason: "payment_already_used" };
    }
    sales.save(txHash, { ...sale, operation, fingerprint, verify: context.result });
  } catch {
    return { abort: true as const, reason: "invalid_payment_operation" };
  }
});
resourceServer.onSettleFailure(async ({ error }) => console.warn(`[settle] ${error.message}`));

const routes: RoutesConfig = {
  [`GET ${ROUTE}`]: {
    accepts: {
      scheme: "exact",
      network: NETWORK,
      payTo,
      price: { amount: PRICE_UNITS, asset: MASUMI_USDM_X402_ASSET },
      maxTimeoutSeconds: 600,
      extra: { assetTransferMethod: "default", areFeesSponsored: false, confirmationPolicy: { l1Confirmations: 1 } },
    },
    description: "Token market and project profile with sources (one query per payment)",
    mimeType: "application/json",
  },
};

const app = express();
app.enable("case sensitive routing");
app.enable("strict routing");
app.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", network: NETWORK, payTo, route: ROUTE, price: { amount: PRICE_UNITS, asset: MASUMI_USDM_X402_ASSET } });
});

app.use(paymentMiddleware(routes, resourceServer));

app.get(ROUTE, async (req, res) => {
  const query = typeof req.query.query === "string" ? req.query.query.trim() : "";
  if (!query || query.length > 100) {
    // A 4xx response cancels settlement, so the buyer is not charged.
    res.status(400).json({ error: "Expected ?query= with 1 to 100 characters" });
    return;
  }
  let txHash: string | undefined;
  try {
    const payment = decodePaymentSignatureHeader(req.get("PAYMENT-SIGNATURE")!);
    txHash = decodeCardanoTransaction(String(payment.payload.transaction)).txHash;
  } catch {
    res.status(400).json({ error: "Unreadable payment" });
    return;
  }
  const sale = sales.get(txHash);
  if (sale?.body !== undefined) {
    res.status(sale.status ?? 200).json(sale.body);
    return;
  }
  try {
    const profile = await lookupToken(query);
    const status = profile.found ? 200 : 404; // not found: no charge
    if (sale) sales.save(txHash, { ...sale, status, body: profile });
    res.status(status).json(profile);
  } catch (error) {
    console.warn(`[data] ${(error as Error).message}`);
    res.status(502).json({ error: "Upstream data source unavailable; you were not charged." });
  }
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Specialist agent on http://127.0.0.1:${PORT}${ROUTE} (pays to ${payTo})`);
});
