// Durable per-key state. Every external write is preceded by a saved
// "*-pending" stage, so a crash leaves evidence instead of a silent retry.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const LOCAL_DIR = ".local";

function ensureDir(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

export function readJson<T>(path: string): T | undefined {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : undefined;
}

// Write to a temporary file and rename, so readers never see a partial file.
export function writeJson(path: string, value: unknown) {
  ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

export function writeText(path: string, text: string) {
  ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

export class Journal<T extends object> {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  path(key: string) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(key)) throw new Error(`Invalid journal key: ${key}`);
    return join(LOCAL_DIR, this.dir, `${key}.json`);
  }

  get(key: string): T | undefined {
    return readJson<T>(this.path(key));
  }

  keys(): string[] {
    const dir = join(LOCAL_DIR, this.dir);
    return existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(".json")).map(f => f.slice(0, -5)) : [];
  }

  save(key: string, state: T): T {
    writeJson(this.path(key), state);
    return state;
  }
}
