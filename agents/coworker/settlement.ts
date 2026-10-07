// Independent proof that the seller was paid: Core's receipt, the matching
// confirmed MPS withdrawal, and the seller's net token gain in that transaction
// measured from Blockfrost inputs and outputs.
import { BLOCKFROST_BASE_URL, required } from "../lib/config.ts";
import type { CoworkerHttp } from "../lib/sokosumi.ts";

interface Utxos {
  inputs: { address: string; amount: { unit: string; quantity: string }[] }[];
  outputs: { address: string; amount: { unit: string; quantity: string }[] }[];
}

export function sellerTokenNet(utxos: Utxos, address: string, unit: string): bigint {
  const sum = (entries: Utxos["inputs"]) =>
    entries
      .filter(entry => entry.address === address)
      .reduce((total, entry) => total + entry.amount.filter(a => a.unit === unit).reduce((n, a) => n + BigInt(a.quantity), 0n), 0n);
  return sum(utxos.outputs) - sum(utxos.inputs);
}

export interface SettlementEvidence {
  verified: boolean;
  receipt?: unknown;
  txHash?: string;
  netAtomicUnits?: string;
  reason?: string;
  method?: string;
}

export async function verifySettlement(args: {
  core: CoworkerHttp;
  taskId: string;
  payment: any;
  sellerAddress: string;
  unit: string;
}): Promise<SettlementEvidence> {
  const receipt = (await args.core.get(`/v1/tasks/${encodeURIComponent(args.taskId)}/receipt`)).data;
  if (!receipt?.settled || !receipt.txHash) return { verified: false, receipt, reason: "Core receipt not settled yet" };
  if (receipt.blockchainIdentifier !== args.payment.blockchainIdentifier) throw new Error("Core receipt payment identifier mismatch");
  const tx = [args.payment.CurrentTransaction, ...(args.payment.TransactionHistory ?? [])].find(
    t => t?.status === "Confirmed" && ["Withdrawn", "DisputedWithdrawn"].includes(t.newOnChainState) && t.txHash === receipt.txHash,
  );
  if (!tx) return { verified: false, receipt, reason: "Matching MPS withdrawal transaction not confirmed" };
  const response = await fetch(`${BLOCKFROST_BASE_URL}/txs/${receipt.txHash}/utxos`, {
    headers: { project_id: required("BLOCKFROST_API_KEY_PREPROD") },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) return { verified: false, receipt, reason: `Blockfrost HTTP ${response.status}` };
  const net = sellerTokenNet((await response.json()) as Utxos, args.sellerAddress, args.unit);
  return {
    verified: net > 0n,
    receipt,
    txHash: receipt.txHash,
    netAtomicUnits: net.toString(),
    method: "Matched Core receipt and confirmed MPS withdrawal hash; measured seller net token change from Blockfrost transaction inputs/outputs",
  };
}
