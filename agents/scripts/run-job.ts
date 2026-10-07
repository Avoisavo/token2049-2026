// Runs one due-diligence job locally, without Sokosumi: Claude parses the
// request, the Coworker wallet buys data from the specialist over x402, Claude
// writes the brief. Proves model + A2A payment before wiring the worker.
//   npm run job -- "Due diligence on SNEK for our treasury team"
// Re-running with the same --id resumes that job (no second payment).
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { Journal } from "../lib/journal.ts";
import { runJob, type JobState } from "../coworker/job.ts";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { id: { type: "string" } } });
const input = positionals.join(" ").trim();
if (!input) throw new Error('Usage: npm run job -- [--id ID] "Task text"');

const id = values.id ?? randomUUID();
const journal = new Journal<JobState & { input: string }>("local-jobs");
const saved = journal.get(id);
if (saved && saved.input !== input) throw new Error(`Job ${id} was started with different input`);

console.error(`job ${id}`);
const result = await runJob(input, saved ?? {}, state => journal.save(id, { ...state, input }));
const purchase = journal.get(id)?.purchase;
console.error(`x402 purchase: ${purchase?.stage ?? "none"} ${purchase?.txHash ?? ""}`);
console.log(result);
