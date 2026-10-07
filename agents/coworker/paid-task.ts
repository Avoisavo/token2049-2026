// Paid Sokosumi Task through the Masumi Payment Service (MPS) escrow.
// Order: signed seller terms -> masumiPayment event -> confirmed FundsLocked ->
// run the job -> submit result hash -> complete the Task -> after unlock,
// verify the seller's collection on chain.
//
// Every external write is preceded by a saved "*-pending" stage. An uncertain
// write is never retried automatically: inspect it before recovering.
// Ported from masumi-network/demo-agent-token2049 (live-demo-name-finder).
import { createHash, randomBytes } from "node:crypto";
import { MASUMI_USDM_UNIT, optional, required } from "../lib/config.ts";
import { readJson } from "../lib/journal.ts";
import { coworkerHttp } from "../lib/sokosumi.ts";
import { verifySettlement, type SettlementEvidence } from "./settlement.ts";

const MINUTE = 60_000;
const QUOTE_UNITS = "1000000"; // 1 test USDM per Task

export const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

// Saved by `npm run mps -- register` / `status`.
export interface Registration {
  agentIdentifier: string;
  supportedPaymentSourceIndex: number;
  walletId: string;
  sellerAddress: string;
  registrationState?: string;
}
export const REGISTRATION_FILE = ".local/mps-registration.json";
export function registration(): Registration | undefined {
  return readJson<Registration>(REGISTRATION_FILE);
}
export function paidReady() {
  return process.env.PAID_TASKS_ENABLED === "true" && registration()?.registrationState === "RegistrationConfirmed";
}

export interface PaidState {
  stage:
    | "terms-pending" | "terms-saved"
    | "purchase-pending" | "awaiting-escrow"
    | "job-running" | "result-saved"
    | "submit-pending" | "awaiting-result"
    | "complete-ready" | "complete-pending"
    | "awaiting-withdrawal" | "settled";
  nonce?: string;
  request?: unknown;
  payment?: any;
  payload?: unknown;
  eventId?: string;
  observed?: any;
  resultHash?: string;
  completionEventId?: string;
  settlement?: SettlementEvidence;
}

async function mps(path: string, body: unknown): Promise<any> {
  const response = await fetch(`${optional("MPS_URL", "http://127.0.0.1:3012")}/api/v1${path}`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: { "content-type": "application/json", token: required("MPS_RUNTIME_TOKEN") },
    body: JSON.stringify(body),
  });
  const data: any = await response.json().catch(() => ({}));
  if (!response.ok || data.status !== "success") throw new Error(`MPS ${path} failed HTTP ${response.status}. Inspect saved state before retrying.`);
  return data.data;
}

export function confirmedState(payment: any, expected: string): boolean {
  return (
    (payment.CurrentTransaction?.status === "Confirmed" && payment.CurrentTransaction?.newOnChainState === expected) ||
    payment.TransactionHistory?.some((tx: any) => tx.status === "Confirmed" && tx.newOnChainState === expected) ||
    false
  );
}

// Core Task events cannot carry non-null signed overrides; refuse terms we cannot submit unchanged.
export function purchasePayload(payment: any, nonce: string, reg: Registration) {
  if (payment.sellerReturnAddress !== null || (payment.forceLayer !== undefined && payment.forceLayer !== null)) {
    throw new Error("Signed terms carry sellerReturnAddress or forceLayer, which Core Task events cannot preserve");
  }
  if (payment.PaymentSource?.network !== "Preprod" || payment.PaymentSource?.paymentSourceType !== "Web3CardanoV2") throw new Error("Payment source is not Preprod Web3CardanoV2");
  if (payment.SmartContractWallet?.id !== reg.walletId) throw new Error("Payment wallet differs from the registered seller wallet");
  if (payment.RequestedFunds?.length !== 1 || payment.RequestedFunds[0].unit !== MASUMI_USDM_UNIT || payment.RequestedFunds[0].amount !== QUOTE_UNITS) {
    throw new Error("Signed quote differs from 1 test USDM");
  }
  return {
    blockchainIdentifier: payment.blockchainIdentifier,
    agentIdentifier: payment.agentIdentifier,
    sellerVkey: payment.SmartContractWallet.walletVkey,
    submitResultTime: payment.submitResultTime,
    payByTime: payment.payByTime,
    unlockTime: payment.unlockTime,
    externalDisputeUnlockTime: payment.externalDisputeUnlockTime,
    inputHash: payment.inputHash,
    identifierFromPurchaser: nonce,
    paymentSourceType: "Web3CardanoV2",
    supportedPaymentSourceIndex: reg.supportedPaymentSourceIndex,
    Amounts: payment.RequestedFunds.map(({ amount, unit }: any) => ({ amount, unit })),
    PaymentSource: { network: "Preprod", smartContractAddress: payment.PaymentSource.smartContractAddress, policyId: payment.PaymentSource.policyId },
  };
}

/**
 * Advance a paid Task by one step. `runJob` must be resumable and return the exact
 * result text; `save` must persist before returning.
 */
export async function advancePaid(
  taskId: string,
  input: string,
  paid: PaidState | undefined,
  save: (paid: PaidState) => void,
  runJob: (deadlineMs: number) => Promise<string>,
): Promise<PaidState | undefined> {
  const reg = registration();
  if (!reg) throw new Error("No confirmed MPS registration saved");
  const set = (next: PaidState) => (save(next), next);

  if (!paid) {
    if (!input.trim()) throw new Error("Paid Task requires its started input");
    const nonce = randomBytes(10).toString("hex");
    const now = Date.now();
    const request = {
      network: "Preprod",
      agentIdentifier: reg.agentIdentifier,
      paymentSourceType: "Web3CardanoV2",
      supportedPaymentSourceIndex: reg.supportedPaymentSourceIndex,
      inputHash: sha256(input), // direct Task payments: raw UTF-8 SHA-256
      identifierFromPurchaser: nonce,
      RequestedFunds: [{ amount: QUOTE_UNITS, unit: MASUMI_USDM_UNIT }],
      payByTime: new Date(now + 5 * MINUTE).toISOString(),
      submitResultTime: new Date(now + 20 * MINUTE).toISOString(),
      unlockTime: new Date(now + 36 * MINUTE).toISOString(),
      externalDisputeUnlockTime: new Date(now + 52 * MINUTE).toISOString(),
      metadata: JSON.stringify({ taskId }),
    };
    set({ stage: "terms-pending", nonce, request });
    const payment = await mps("/payment", request);
    return set({ stage: "terms-saved", nonce, request, payment });
  }

  switch (paid.stage) {
    case "terms-saved": {
      if (Date.now() >= Number(paid.payment.payByTime)) throw new Error("Signed pay-by deadline expired; inspect before requesting new terms");
      const payload = purchasePayload(paid.payment, paid.nonce!, reg);
      set({ ...paid, payload, stage: "purchase-pending" });
      const response = await (await coworkerHttp()).post(`/v1/tasks/${encodeURIComponent(taskId)}/events`, {
        comment: "Payment requested: 1 test USDM.",
        masumiPayment: payload,
      });
      return set({ ...paid, payload, stage: "awaiting-escrow", eventId: response.data.id });
    }

    case "awaiting-escrow":
    case "awaiting-result":
    case "awaiting-withdrawal": {
      const observed = await mps("/payment/resolve-blockchain-identifier", {
        network: "Preprod",
        blockchainIdentifier: paid.payment.blockchainIdentifier,
        includeHistory: "true",
      });
      paid = set({ ...paid, observed });
      if (paid.stage === "awaiting-escrow") {
        if (observed.onChainState !== "FundsLocked" || !confirmedState(observed, "FundsLocked")) return paid;
        if (Date.now() >= Number(paid.payment.submitResultTime)) throw new Error("Result deadline passed before the job started");
        return set({ ...paid, stage: "job-running" });
      }
      if (paid.stage === "awaiting-result") {
        if (observed.onChainState === "ResultSubmitted" && observed.resultHash === paid.resultHash && confirmedState(observed, "ResultSubmitted")) {
          return set({ ...paid, stage: "complete-ready" });
        }
        return paid;
      }
      if (["Withdrawn", "DisputedWithdrawn"].includes(observed.onChainState)) {
        const settlement = await verifySettlement({
          core: await coworkerHttp(),
          taskId,
          payment: observed,
          sellerAddress: reg.sellerAddress,
          unit: MASUMI_USDM_UNIT,
        });
        return set({ ...paid, settlement, stage: settlement.verified ? "settled" : "awaiting-withdrawal" });
      }
      return paid;
    }

    case "job-running": {
      // The job journals its own steps (x402 purchase, Claude calls), so re-entry is safe.
      const result = await runJob(Number(paid.payment.submitResultTime));
      return set({ ...paid, stage: "result-saved", resultHash: sha256(result) });
    }

    case "result-saved": {
      if (Date.now() >= Number(paid.payment.submitResultTime)) throw new Error("Result deadline passed before submission");
      set({ ...paid, stage: "submit-pending" });
      await mps("/payment/submit-result", {
        network: "Preprod",
        blockchainIdentifier: paid.payment.blockchainIdentifier,
        submitResultHash: paid.resultHash,
      });
      return set({ ...paid, stage: "awaiting-result" });
    }

    case "complete-ready": {
      const result = await runJob(Number(paid.payment.submitResultTime)); // returns the saved result
      if (sha256(result) !== paid.resultHash) throw new Error("Saved result no longer matches the submitted hash");
      set({ ...paid, stage: "complete-pending" });
      const response = await (await coworkerHttp()).post(`/v1/tasks/${encodeURIComponent(taskId)}/events`, { status: "COMPLETED", comment: result });
      return set({ ...paid, stage: "awaiting-withdrawal", completionEventId: response.data.id });
    }

    case "settled":
      return paid;

    default:
      throw new Error(`Uncertain stage ${paid.stage}. Inspect the earlier operation before recovering; automatic retry is disabled.`);
  }
}
