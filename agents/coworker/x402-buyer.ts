// The Coworker's own wallet pays the specialist agent over x402 (agent-to-agent).
//
// Exactly-once intent: the signed payment is saved before it is sent. After a
// crash or a pending settlement the SAME signed transaction is resent, never a
// new one. A fresh payment is signed only after the old transaction has
// expired and the chain shows it was never included.
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentRequired } from "@x402/core/types";
import { decodeCardanoTransaction, toClientCardanoSigner } from "@x402/cardano";
import { ExactCardanoScheme } from "@x402/cardano/exact/client";
import { addressOf, BLOCKFROST_BASE_URL, blockfrostProvider, MASUMI_USDM_X402_ASSET, NETWORK, optional, required } from "../lib/config.ts";

export interface SubPurchase {
  stage: "signed" | "settled" | "not-found" | "expired";
  url: string;
  headers?: Record<string, string>; // PAYMENT-SIGNATURE for the saved signed transaction
  txHash?: string;
  signedAt?: number;
  attempts?: number;
  settle?: unknown;
  body?: unknown;
  expiredTxHashes?: string[];
}

// Sign at most this many atomic units per payment (default 0.25 tUSDM).
const MAX_UNITS = optional("X402_MAX_PAYMENT_UNITS", "250000");
// The specialist offers maxTimeoutSeconds 600; add margin for chain indexing.
const EXPIRY_MS = 15 * 60_000;

let http: x402HTTPClient | undefined;
function client() {
  if (!http) {
    const signer = toClientCardanoSigner({ mnemonic: required("BUYER_MNEMONIC"), network: NETWORK, provider: blockfrostProvider() });
    const core = new x402Client().register(NETWORK, new ExactCardanoScheme(signer)).setSpendControls({
      maxAmountPerPayment: false,
      allowedAssets: [{ network: NETWORK, asset: MASUMI_USDM_X402_ASSET, maxAmountPerPayment: MAX_UNITS }],
    });
    http = new x402HTTPClient(core);
  }
  return http;
}

export function buyerAddress() {
  return addressOf(required("BUYER_MNEMONIC"));
}

async function onChain(txHash: string): Promise<boolean> {
  const response = await fetch(`${BLOCKFROST_BASE_URL}/txs/${txHash}`, {
    headers: { project_id: required("BLOCKFROST_API_KEY_PREPROD") },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`Blockfrost HTTP ${response.status}; payment state unknown`);
  return true;
}

async function readBody(response: Response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Advance one purchase by one step. `save` must persist durably before it returns.
 * Returns the state; callers repeat until stage is "settled" or "not-found".
 */
export async function advancePurchase(
  url: string,
  state: SubPurchase | undefined,
  save: (state: SubPurchase) => void,
): Promise<SubPurchase> {
  const x402 = client();

  if (state?.stage === "settled" || state?.stage === "not-found") return state;

  if (state?.stage === "signed") {
    // Resend the identical signed payment.
    const response = await fetch(state.url, { headers: state.headers, signal: AbortSignal.timeout(240_000) });
    const attempts = (state.attempts ?? 0) + 1;
    if (response.ok) {
      const settle = x402.getPaymentSettleResponse(name => response.headers.get(name));
      const next: SubPurchase = { ...state, stage: "settled", attempts, settle, body: await readBody(response) };
      save(next);
      return next;
    }
    // 400/404: the specialist declined the query, which cancels settlement (no charge).
    if (response.status === 400 || response.status === 404) {
      const next: SubPurchase = { ...state, stage: "not-found", attempts, body: await readBody(response) };
      save(next);
      return next;
    }
    // Pending, transient or rejected. Only a confirmed absence after expiry frees us to re-sign.
    if (Date.now() - (state.signedAt ?? 0) > EXPIRY_MS && state.txHash && !(await onChain(state.txHash))) {
      const next: SubPurchase = {
        stage: "expired",
        url: state.url,
        expiredTxHashes: [...(state.expiredTxHashes ?? []), state.txHash],
      };
      save(next);
      return next;
    }
    const next: SubPurchase = { ...state, attempts };
    save(next);
    console.warn(`[x402] payment ${state.txHash} not settled yet (HTTP ${response.status}); will resend the same payment`);
    return next;
  }

  // No payment in flight: ask for the price, sign, save, then send.
  const offer = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (offer.status !== 402) throw new Error(`Specialist answered HTTP ${offer.status} instead of a price`);
  const paymentRequired: PaymentRequired = x402.getPaymentRequiredResponse(name => offer.headers.get(name), await readBody(offer));
  const payload = await x402.createPaymentPayload(paymentRequired);
  const headers = x402.encodePaymentSignatureHeader(payload);
  const txHash = decodeCardanoTransaction(String(payload.payload.transaction)).txHash;
  const signed: SubPurchase = { stage: "signed", url, headers, txHash, signedAt: Date.now(), attempts: 0, expiredTxHashes: state?.expiredTxHashes };
  save(signed);
  return advancePurchase(url, signed, save);
}
