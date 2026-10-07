// One configuration loader for every agent process. Secrets live in .env.local
// (git-ignored, mode 0600); .env.example documents the names without values.
// Values already set in the process environment win over the file.
import { existsSync } from "node:fs";
import { toClientCardanoSigner } from "@x402/cardano";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

export function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set. Add it to .env.local (see .env.example).`);
  return value;
}

export function optional(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

export const NETWORK = "cardano:preprod";
export const BLOCKFROST_BASE_URL = "https://cardano-preprod.blockfrost.io/api/v0";

// Masumi's test USDM (from dispenser.masumi.network). Not the SDK's default
// preprod tUSDM (policy e675b46e…), which is a different asset.
export const MASUMI_USDM_POLICY = "16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde";
export const MASUMI_USDM_ASSET_NAME = "0014df10745553444d";
export const MASUMI_USDM_UNIT = MASUMI_USDM_POLICY + MASUMI_USDM_ASSET_NAME;
export const MASUMI_USDM_X402_ASSET = `${MASUMI_USDM_POLICY}.${MASUMI_USDM_ASSET_NAME}`;

export const HOSTED_FACILITATOR_URL = "https://x402.preprod.dev.ecosyseng.cf-deployments.org";

// Address derivation is offline; the provider is only consulted when signing.
export function addressOf(mnemonic: string): string {
  return toClientCardanoSigner({ mnemonic, network: NETWORK, provider: { blockfrost: { baseUrl: BLOCKFROST_BASE_URL } } }).getAddress();
}

export function blockfrostProvider() {
  return {
    blockfrost: { baseUrl: BLOCKFROST_BASE_URL, projectId: required("BLOCKFROST_API_KEY_PREPROD") },
    requestTimeoutMs: 30_000,
  };
}
