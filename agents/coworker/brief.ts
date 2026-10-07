// Claude turns a Task request plus purchased data into a sourced due-diligence brief.
import Anthropic from "@anthropic-ai/sdk";
import { optional } from "../lib/config.ts";

const MODEL = optional("ANTHROPIC_MODEL", "claude-opus-5-5");
let anthropic: Anthropic | undefined;
const client = () => (anthropic ??= new Anthropic());

// Server-side refusal fallback: a declined request is re-run on Anthropic's
// recommended fallback model inside the same call.
const FALLBACK = { betas: ["server-side-fallback-2026-07-01"] as Anthropic.Beta.AnthropicBeta[], fallbacks: "default" as const };

function text(message: Anthropic.Beta.BetaMessage): string {
  if (message.stop_reason === "refusal") throw new Error(`Model declined the request (${message.stop_details?.category ?? "no category"})`);
  if (message.stop_reason === "max_tokens") throw new Error("Model output was cut off at max_tokens");
  const out = message.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("").trim();
  if (!out) throw new Error("Model returned no text");
  return out;
}

export interface Request {
  token: string | null; // name, ticker or CoinGecko id to look up
  audience: string; // who will use the brief
  focus: string; // what decision the brief should support
}

export async function parseRequest(task: string): Promise<Request> {
  const message = await client().beta.messages.create({
    model: MODEL,
    max_tokens: 2000,
    output_config: {
      effort: "low",
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["token", "audience", "focus"],
          properties: {
            token: { type: ["string", "null"], description: "The single crypto token or project to research, as named by the requester. null if none is named." },
            audience: { type: "string", description: "Who will read the brief, e.g. 'treasury team'. 'unspecified' if not stated." },
            focus: { type: "string", description: "The decision or question the brief must answer. 'general due diligence' if not stated." },
          },
        },
      },
    },
    messages: [{ role: "user", content: `Extract the research request from this task.\n\n<task>\n${task}\n</task>` }],
    ...FALLBACK,
  });
  return JSON.parse(text(message)) as Request;
}

const SYSTEM = `You write token due-diligence briefs for business teams deciding whether to hold, list, integrate or partner with a crypto project.

Use only the purchased data provided. Every number you state must come from that data, and you cite its source URL inline. If a fact the decision needs is missing or null, say so plainly under "Gaps" instead of estimating it. If the data matched a different project than the requester probably meant (see otherMatches), say so first.

Write in Markdown with these sections:
1. Verdict: one sentence with a risk level (Low / Medium / High / Insufficient data) and the main reason.
2. Snapshot: price, market cap and rank, 24h volume, supply, and distance from all-time high, with the retrieval timestamp.
3. Signals: liquidity, volatility, supply overhang (circulating vs max), development activity, chain footprint. One line each, each with its evidence.
4. Gaps: what this data cannot tell you (audits, team, token unlock schedule, legal status, holder concentration), and what to check next.
5. Sources: the URLs you used.

Keep it under 450 words. This is decision support, not investment advice; say that once at the end.`;

export async function writeBrief(request: Request, task: string, data: unknown, payment: { txHash?: string }): Promise<string> {
  const stream = client().beta.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: "high" },
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          `<task>\n${task}\n</task>`,
          `<request>\n${JSON.stringify(request)}\n</request>`,
          `<purchased_data provider="specialist data agent" paid_via="x402 on Cardano preprod" tx="${payment.txHash ?? "none"}">\n${JSON.stringify(data, null, 2)}\n</purchased_data>`,
        ].join("\n\n"),
      },
    ],
    ...FALLBACK,
  });
  return text(await stream.finalMessage());
}
