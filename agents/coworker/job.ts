// One due-diligence job: understand the request, buy data from the specialist
// over x402, write the brief. Each step's output is saved before the next
// starts, so a restart resumes without asking Claude or paying again.
import { optional } from "../lib/config.ts";
import { parseRequest, writeBrief, type Request } from "./brief.ts";
import { advancePurchase, type SubPurchase } from "./x402-buyer.ts";

export interface JobState {
  request?: Request;
  purchase?: SubPurchase;
  result?: string;
}

const SPECIALIST_URL = optional("SPECIALIST_URL", "http://127.0.0.1:4021");
const explorer = (txHash: string) => `https://preprod.cardanoscan.io/transaction/${txHash}`;

export class PaymentPending extends Error {}

export async function runJob(input: string, state: JobState, save: (state: JobState) => void): Promise<string> {
  if (state.result !== undefined) return state.result;
  if (typeof input !== "string" || !input.trim() || input.length > 16_000) throw new Error("Task input must contain 1 to 16000 characters");

  if (!state.request) {
    state = { ...state, request: await parseRequest(input) };
    save(state);
  }
  const request = state.request!;

  if (!request.token) {
    const result =
      "I could not find which token or project to research in this Task. Please name one (for example \"SNEK\" or \"Cardano\") and what decision the brief should support. No data was purchased.";
    save({ ...state, result });
    return result;
  }

  const url = `${SPECIALIST_URL}/v1/token-profile?query=${encodeURIComponent(request.token)}`;
  let purchase = state.purchase;
  // A signed payment from an earlier run is resent as-is; see x402-buyer.ts.
  for (let step = 0; step < 3 && purchase?.stage !== "settled" && purchase?.stage !== "not-found"; step++) {
    purchase = await advancePurchase(url, purchase, next => {
      state = { ...state, purchase: next };
      save(state);
    });
  }
  if (purchase?.stage !== "settled" && purchase?.stage !== "not-found") {
    throw new PaymentPending(`Specialist payment ${purchase?.txHash ?? ""} is still settling; will check again`);
  }

  let result: string;
  if (purchase.stage === "not-found") {
    result = `The specialist data agent has no listing for "${request.token}", so no data was bought and no payment was made. Check the spelling or give the ticker or CoinGecko id.`;
  } else {
    const brief = await writeBrief(request, input, purchase.body, { txHash: purchase.txHash });
    const price = Number(optional("SPECIALIST_PRICE_UNITS", "100000")) / 1_000_000;
    result = `${brief}\n\n---\nData bought agent-to-agent over x402: ${price.toFixed(2)} test USDM paid by this Coworker to the specialist data agent on Cardano preprod, transaction ${purchase.txHash} (${explorer(purchase.txHash!)}).`;
  }
  save({ ...state, result });
  return result;
}
