// One executor per Coworker. A second worker on the same machine refuses to
// start while the recorded owner process is alive.
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function ownerPid(path: string): number {
  const text = readFileSync(path, "utf8").trim();
  if (!/^[1-9][0-9]*$/.test(text)) throw new Error(`Lock ${path} has an invalid owner. Inspect it before removing.`);
  return Number(text);
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export function acquireLock(path: string): () => void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const pid = ownerPid(path);
    if (isAlive(pid)) throw new Error(`Another worker is already running (pid ${pid}).`);
    unlinkSync(path);
    fd = openSync(path, "wx", 0o600);
  }
  writeFileSync(fd, String(process.pid));
  closeSync(fd);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      if (ownerPid(path) === process.pid) unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
}
