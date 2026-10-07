// FOR (Fresh Or Refund) Coworker worker: picks up Sokosumi Tasks assigned to the FOR
// Coworker, runs one freshness-guaranteed x402 purchase with buy.mjs, and
// completes the Task with the receipt.
//
// Task text examples: "ETH price no more than 10 seconds old",
// "BTC within 5s, pay 0.25 USDM", "Cardano price, impossible freshness".
//
// A purchase moves real test USDM, so it is never re-run automatically: a crash
// between starting buy.mjs and saving its receipt leaves the Task blocked for
// inspection instead of paying twice.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { required } from "../lib/config.ts";
import { Journal, LOCAL_DIR, writeText } from "../lib/journal.ts";
import { acquireLock } from "../lib/lock.ts";
import { cli } from "../lib/sokosumi.ts";

const COWORKER_ID = required("COWORKER_ID");
const EVENT_ORG_ID = "01a109d1-32a9-71a3-a0e3-658b2a7987cd";
const EVENT_ORG_SLUG = "token2049-origins-hackathon-2026-nws2r7";
const POLL_MS = 5_000;

// Personal Workspace always; the TOKEN2049 Workspace once access is approved.
// `tasks list` takes no --personal flag: unscoped it returns personal Tasks
// (organizationId null), which `org` filters to.
const SCOPES = [
  { name: "personal", tasks: [], runtime: ["--personal"], org: null },
  { name: "token2049", tasks: ["--organization-slug", EVENT_ORG_SLUG], runtime: ["--organization-id", EVENT_ORG_ID], org: EVENT_ORG_ID },
] as const;
type Scope = (typeof SCOPES)[number];

interface TaskState {
  phase: "starting" | "started" | "buy-pending" | "result-saved" | "complete-pending" | "completed";
  scope: Scope["name"];
  input?: string;
  order?: Order;
  exitCode?: number;
}

interface Order {
  asset: string;
  window: number;
  price: number;
}

const ASSETS: Record<string, string> = {
  ETH: "ETH", ETHER: "ETH", ETHEREUM: "ETH",
  BTC: "BTC", BITCOIN: "BTC",
  ADA: "ADA", CARDANO: "ADA",
  SOL: "SOL", SOLANA: "SOL",
  AAVE: "AAVE",
};

export function parseOrder(text: string): Order | { error: string } {
  const words = text.toUpperCase().match(/[A-Z]+/g) ?? [];
  const asset = words.map(w => ASSETS[w]).find(Boolean);
  if (!asset) return { error: "Please name one asset: ETH, BTC, ADA, SOL or AAVE." };

  let window = 10;
  if (/impossible|refund demo/i.test(text)) window = 0.000001;
  const age = text.match(/(\d+(?:\.\d+)?)\s*(ms|millisecond|milliseconds|s|sec|secs|second|seconds)\b/i);
  if (age) window = Number(age[1]) / (/^ms|^milli/i.test(age[2]) ? 1000 : 1);

  let price = 0.1;
  const pay = text.match(/(\d+(?:\.\d+)?)\s*(t?usdm)\b/i);
  if (pay) price = Number(pay[1]);
  if (!(window > 0) || !(price > 0) || price > 1) return { error: "Freshness window must be positive and the price at most 1 USDM." };
  return { asset, window, price };
}

const tasks = new Journal<TaskState>("freshproof-tasks");
const resultFile = (taskId: string) => join(LOCAL_DIR, "freshproof-results", `${taskId}.txt`);
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "");

function buy(order: Order): { code: number; output: string } {
  const run = spawnSync(
    process.execPath,
    [".claude/skills/freshproof/buy.mjs", order.asset, "--window", String(order.window), "--price", String(order.price), "--fast"],
    { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" }, timeout: 300_000, maxBuffer: 4 * 1024 * 1024 },
  );
  return { code: run.status ?? 1, output: stripAnsi(`${run.stdout ?? ""}${run.stderr ?? ""}`).trim() };
}

function report(order: Order, code: number, receipt: string): string {
  const head =
    code === 0
      ? `FOR purchase: ${order.asset}/USD, max age ${order.window} s, ${order.price} USDM via x402 on Cardano Preprod.`
      : `FOR purchase for ${order.asset}/USD did not complete. No further payment was attempted.`;
  return `${head}\n\n${receipt.slice(0, 900_000)}\n`;
}

async function advance(scope: Scope, taskId: string, status: string) {
  let state = tasks.get(taskId);

  if (!state && status === "READY") {
    state = tasks.save(taskId, { phase: "starting", scope: scope.name });
    const started = cli<{ description?: string }>(["runtime", "start", taskId, "--coworker-id", COWORKER_ID, ...scope.runtime]);
    state = tasks.save(taskId, { phase: "started", scope: scope.name, input: String(started.description ?? "") });
    console.log(`[${taskId}] started in ${scope.name}: ${state.input!.slice(0, 80)}`);
  }
  if (!state || state.scope !== scope.name) return;

  if (state.phase === "started") {
    const order = parseOrder(state.input ?? "");
    if ("error" in order) {
      writeText(resultFile(taskId), `${order.error} No payment was made.\n`);
      state = tasks.save(taskId, { ...state, phase: "result-saved" });
    } else {
      tasks.save(taskId, { ...state, order, phase: "buy-pending" });
      const { code, output } = buy(order);
      writeText(resultFile(taskId), report(order, code, output));
      state = tasks.save(taskId, { ...state, order, exitCode: code, phase: "result-saved" });
      console.log(`[${taskId}] buy.mjs exited ${code}`);
    }
  }
  if (state.phase === "buy-pending") {
    throw new Error("A purchase started but its receipt was not saved. Check the buyer wallet on Preprod before retrying.");
  }
  if (state.phase === "result-saved") {
    tasks.save(taskId, { ...state, phase: "complete-pending" });
    cli(["runtime", "complete", taskId, "--coworker-id", COWORKER_ID, ...scope.runtime, "--result-file", resultFile(taskId)]);
    tasks.save(taskId, { ...state, phase: "completed" });
    console.log(`[${taskId}] completed`);
  }
  if (state.phase === "complete-pending") {
    throw new Error("Completion outcome unknown. Inspect the Task before retrying.");
  }
}

const release = acquireLock(join(LOCAL_DIR, "freshproof-worker.lock"));
process.once("exit", release);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => process.exit(0));
console.log(`FOR worker ${process.pid} polling Tasks for Coworker ${COWORKER_ID}`);

const quiet = new Set<string>();
while (true) {
  for (const scope of SCOPES) {
    let list: { id: string; status: string; coworkerId?: string; organizationId?: string | null }[];
    try {
      list = cli<{ tasks: typeof list }>(["tasks", "list", "--coworker-id", COWORKER_ID, ...scope.tasks]).tasks ?? [];
      quiet.delete(scope.name);
    } catch (error) {
      // The event Workspace refuses reads until access is approved; say so once.
      if (!quiet.has(scope.name)) console.log(`[${scope.name}] not readable yet: ${(error as Error).message.split("\n")[0].slice(0, 160)}`);
      quiet.add(scope.name);
      continue;
    }
    const mine = list.filter(t => (!t.coworkerId || t.coworkerId === COWORKER_ID) && (t.organizationId ?? null) === scope.org);
    for (const task of mine) {
      try {
        await advance(scope, task.id, task.status);
      } catch (error) {
        console.error(`[${task.id}] blocked: ${(error as Error).message.slice(0, 300)}`);
      }
    }
  }
  await new Promise(resolve => setTimeout(resolve, POLL_MS));
}
