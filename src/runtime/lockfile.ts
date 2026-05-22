import { randomUUID } from "node:crypto";
import { open, readFile, rm, stat } from "node:fs/promises";

const STALE_UNINSPECTABLE_LOCK_MS = 30_000;

type LockMetadata = {
  pid?: unknown;
  token?: unknown;
  createdAt?: unknown;
};

export async function acquireLock(path: string): Promise<() => Promise<void>> {
  const token = randomUUID();
  while (true) {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }));
      } finally {
        await handle.close();
      }
      return async () => {
        await releaseLock(path, token);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }

      const existing = await readExistingLock(path);
      if (existing === undefined) {
        continue;
      }
      if (existing === null) {
        if (await removeUninspectableLockIfStale(path)) {
          continue;
        }
        throw new Error(`live lock exists at ${path} but could not be inspected`);
      }

      const pid = existing.pid;
      if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
        if (await removeUninspectableLockIfStale(path)) {
          continue;
        }
        throw new Error(`live lock exists at ${path} with invalid pid`);
      }

      if (isProcessRunning(pid)) {
        throw new Error(`live lock is already held by pid ${pid}`);
      }

      await rm(path, { force: true });
    }
  }
}

async function releaseLock(path: string, token: string): Promise<void> {
  const existing = await readExistingLock(path);
  if (
    existing &&
    typeof existing.token === "string" &&
    existing.token === token &&
    existing.pid === process.pid
  ) {
    await rm(path, { force: true });
  }
}

async function readExistingLock(path: string): Promise<LockMetadata | null | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as LockMetadata;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    return null;
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function removeUninspectableLockIfStale(path: string): Promise<boolean> {
  try {
    const lockStat = await stat(path);
    if (Date.now() - lockStat.mtimeMs < STALE_UNINSPECTABLE_LOCK_MS) {
      return false;
    }
    await rm(path, { force: true });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return true;
    }
    throw error;
  }
}
