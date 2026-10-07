// Sokosumi Coworker worker: polls Tasks assigned to this Coworker and runs the
// due-diligence job for each. Unpaid Tasks complete through the CLI; with a
// confirmed Masumi registration and PAID_TASKS_ENABLED=true, Tasks go through
// the MPS escrow flow in paid-task.ts. One worker per Coworker (lock file).
import { join } from "node:path";
import { Journal, LOCAL_DIR, writeText } from "../lib/journal.ts";
import { acquireLock } from "../lib/lock.ts";
import { completeTask, COWORKER_ID, listTasks, startTask } from "../lib/sokosumi.ts";
import { runJob, PaymentPending, type JobState } from "./job.ts";
import { advancePaid, paidReady, type PaidState } from "./paid-task.ts";

interface TaskState {
  phase: "starting" | "started" | "result-saved" | "complete-pending" | "completed";
  mode?: "paid" | "unpaid";
  input?: string;
  job?: JobState;
  paid?: PaidState;
  completion?: unknown;
  error?: string;
}

const POLL_MS = 5_000;
const tasks = new Journal<TaskState>("tasks");
const resultFile = (taskId: string) => join(LOCAL_DIR, "results", `${taskId}.txt`);

const release = acquireLock(join(LOCAL_DIR, "worker.lock"));
process.once("exit", release);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => process.exit(0));

COWORKER_ID(); // fail fast when unconfigured
console.log(`Worker ${process.pid} polling Tasks for Coworker ${COWORKER_ID()} (paid mode: ${paidReady() ? "on" : "off"})`);

function job(taskId: string, state: TaskState) {
  return () =>
    runJob(state.input!, state.job ?? {}, next => {
      state.job = next;
      tasks.save(taskId, state);
    });
}

async function advance(taskId: string, status: string | undefined) {
  let state = tasks.get(taskId);

  if (!state && status === "READY") {
    state = tasks.save(taskId, { phase: "starting" });
    const started = startTask(taskId);
    if (typeof started.description !== "string") throw new Error("runtime start returned no Task input");
    state = tasks.save(taskId, { phase: "started", input: started.description, mode: paidReady() ? "paid" : "unpaid" });
    console.log(`[${taskId}] started (${state.mode})`);
  }
  if (!state) return;
  if (state.phase === "starting") throw new Error("Start outcome unknown. Inspect the Task, then set phase to started or delete the journal.");

  if (state.mode === "paid") {
    if (state.paid?.stage === "settled") return;
    if (!paidReady()) return;
    const s = state;
    s.paid = await advancePaid(taskId, s.input!, s.paid, paid => {
      s.paid = paid;
      tasks.save(taskId, s);
    }, async deadline => {
      if (Date.now() >= deadline) throw new Error("Result deadline passed");
      return job(taskId, s)();
    });
    if (s.paid?.stage === "awaiting-withdrawal" && s.phase !== "completed") tasks.save(taskId, { ...s, phase: "completed" });
    if (s.paid?.stage === "settled") console.log(`[${taskId}] seller collection verified: ${s.paid.settlement?.txHash}`);
    return;
  }

  if (state.phase === "started") {
    const result = await job(taskId, state)();
    writeText(resultFile(taskId), result);
    state = tasks.save(taskId, { ...state, phase: "result-saved" });
  }
  if (state.phase === "result-saved") {
    tasks.save(taskId, { ...state, phase: "complete-pending" });
    const completion = completeTask(taskId, resultFile(taskId));
    tasks.save(taskId, { ...state, phase: "completed", completion });
    console.log(`[${taskId}] completed`);
  }
  if (state.phase === "complete-pending") {
    throw new Error("Completion outcome unknown. Inspect the Task before retrying.");
  }
}

while (true) {
  try {
    const listed = listTasks().filter(t => t.coworkerId === undefined || t.coworkerId === COWORKER_ID());
    const seen = new Set<string>();
    for (const task of listed) {
      seen.add(task.id);
      try {
        await advance(task.id, task.status);
      } catch (error) {
        const message = (error as Error).message.slice(0, 300);
        if (error instanceof PaymentPending) console.log(`[${task.id}] ${message}`);
        else console.error(`[${task.id}] blocked: ${message}`);
      }
    }
    // Paid Tasks keep moving after completion until the seller's collection is verified.
    for (const taskId of tasks.keys()) {
      if (seen.has(taskId)) continue;
      const state = tasks.get(taskId);
      if (state?.mode !== "paid" || state.paid?.stage === "settled") continue;
      try {
        await advance(taskId, undefined);
      } catch (error) {
        console.error(`[${taskId}] blocked: ${(error as Error).message.slice(0, 300)}`);
      }
    }
  } catch (error) {
    console.error(`Polling failed: ${(error as Error).message.slice(0, 300)}`);
  }
  await new Promise(resolve => setTimeout(resolve, POLL_MS));
}
