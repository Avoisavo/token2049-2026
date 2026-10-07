// Sokosumi access for the worker. Reads and runtime start/complete go through the
// CLI (which uses the Coworker runtime key from its vault); payment events use
// the CLI's own Coworker HTTP client with that same key. Never the account token.
import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { optional, required } from "./config.ts";

export const COWORKER_ID = () => required("COWORKER_ID");

// Personal Workspace for testing; the TOKEN2049 event Workspace after approval.
// Task commands take the organization slug, runtime commands the organization id.
function scope(kind: "tasks" | "runtime"): string[] {
  const orgId = process.env.SOKOSUMI_ORGANIZATION_ID?.trim();
  const orgSlug = process.env.SOKOSUMI_ORGANIZATION_SLUG?.trim();
  if (!orgId && !orgSlug) return ["--personal"];
  if (kind === "runtime") return ["--organization-id", required("SOKOSUMI_ORGANIZATION_ID")];
  return ["--organization-slug", required("SOKOSUMI_ORGANIZATION_SLUG")];
}

export function cli<T = any>(args: string[]): T {
  const env = optional("SOKOSUMI_ENV", "preprod");
  const out = execFileSync("sokosumi", [`--${env}`, ...args, "--json"], {
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(out) as T;
}

export interface SokosumiTask {
  id: string;
  status: string;
  coworkerId?: string;
  name?: string;
  description?: string;
}

export function listTasks(): SokosumiTask[] {
  return cli<{ tasks: SokosumiTask[] }>(["tasks", "list", "--coworker-id", COWORKER_ID(), ...scope("tasks")]).tasks ?? [];
}

export function startTask(taskId: string): { description?: string } & Record<string, unknown> {
  return cli(["runtime", "start", taskId, "--coworker-id", COWORKER_ID(), ...scope("runtime")]);
}

export function completeTask(taskId: string, resultFile: string) {
  return cli(["runtime", "complete", taskId, "--coworker-id", COWORKER_ID(), ...scope("runtime"), "--result-file", resultFile]);
}

// The CLI package ships the runtime client; load it from the installed CLI.
interface Runtime {
  readRuntimeCredential(coworkerId: string): string;
  createCoworkerHttpClient(options: { apiKey: string }): CoworkerHttp;
}
export interface CoworkerHttp {
  get(path: string): Promise<{ data: any }>;
  post(path: string, body: unknown): Promise<{ data: any }>;
}

let http: Promise<CoworkerHttp> | undefined;
export function coworkerHttp(): Promise<CoworkerHttp> {
  http ??= (async () => {
    const skills = execFileSync("sokosumi", ["skills", "path"], { encoding: "utf8", timeout: 30_000 }).trim();
    if (!isAbsolute(skills) || !skills.endsWith("/skills")) throw new Error("sokosumi skills path returned an unexpected path");
    const root = join(dirname(skills), "dist", "src");
    const modules = await Promise.all(
      ["coworker/runtime-credentials.js", "api/http-client.js"].map(p => import(pathToFileURL(join(root, p)).href)),
    );
    const runtime = Object.assign({}, ...modules) as Runtime;
    return runtime.createCoworkerHttpClient({ apiKey: runtime.readRuntimeCredential(COWORKER_ID()) });
  })();
  return http;
}
