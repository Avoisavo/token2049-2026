// Creates the two preprod test wallets this project needs, if missing, and
// prints only their public addresses and balances. Mnemonics go straight into
// .env.local (mode 0600) and are never printed.
//   BUYER_MNEMONIC      - the Coworker's wallet; pays the specialist over x402
//   SPECIALIST_MNEMONIC - the specialist data agent's receiving wallet
import { appendFileSync, chmodSync, existsSync, lstatSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { parseEnv } from "node:util";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { addressOf, BLOCKFROST_BASE_URL, MASUMI_USDM_UNIT } from "../lib/config.ts";

const FILE = ".env.local";
if (execFileSyncStatus(["check-ignore", "--quiet", FILE]) !== 0) throw new Error(`${FILE} must be git-ignored before secrets are written to it`);
if (existsSync(FILE) && !lstatSync(FILE).isFile()) throw new Error(`${FILE} is not a regular file`);

const saved = existsSync(FILE) ? parseEnv(readFileSync(FILE, "utf8")) : {};
for (const name of ["BUYER_MNEMONIC", "SPECIALIST_MNEMONIC"]) {
  if (saved[name] || process.env[name]) continue;
  const prior = existsSync(FILE) ? readFileSync(FILE, "utf8") : "";
  appendFileSync(FILE, `${prior && !prior.endsWith("\n") ? "\n" : ""}${name}="${generateMnemonic(wordlist, 256)}"\n`, { mode: 0o600 });
  console.log(`Created ${name} in ${FILE}`);
}
chmodSync(FILE, 0o600);
process.loadEnvFile(FILE);


async function balance(addr: string) {
  if (!process.env.BLOCKFROST_API_KEY_PREPROD) return "(set BLOCKFROST_API_KEY_PREPROD to show balance)";
  const response = await fetch(`${BLOCKFROST_BASE_URL}/addresses/${addr}`, { headers: { project_id: process.env.BLOCKFROST_API_KEY_PREPROD } });
  if (response.status === 404) return "0 tADA, 0 tUSDM (address unused)";
  if (!response.ok) return `(Blockfrost HTTP ${response.status})`;
  const { amount } = (await response.json()) as { amount: { unit: string; quantity: string }[] };
  const of = (unit: string) => BigInt(amount.find(a => a.unit === unit)?.quantity ?? "0");
  return `${Number(of("lovelace")) / 1e6} tADA, ${Number(of(MASUMI_USDM_UNIT)) / 1e6} tUSDM`;
}

for (const [label, name, need] of [
  ["Coworker buyer wallet", "BUYER_MNEMONIC", "test ADA (fees, min-UTxO) and test USDM (x402 payments)"],
  ["Specialist receiving wallet", "SPECIALIST_MNEMONIC", "a few test ADA only (receives tUSDM)"],
] as const) {
  const addr = addressOf(process.env[name]!);
  console.log(`\n${label}\n  network: Cardano preprod\n  address: ${addr}\n  balance: ${await balance(addr)}\n  needs:   ${need}`);
}
console.log("\nFund at https://dispenser.masumi.network (choose Preprod; use the code from your Masumi registration email).");

function execFileSyncStatus(args: string[]) {
  try {
    execFileSync("git", args, { stdio: "ignore" });
    return 0;
  } catch (error) {
    return (error as { status?: number }).status ?? 1;
  }
}
