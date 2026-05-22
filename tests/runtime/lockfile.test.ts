import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireLock } from "../../src/runtime/lockfile.js";

describe("runtime lockfile", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  async function lockPath(): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), "polycopy-lock-"));
    return join(dir, "polycopy.lock");
  }

  it("reclaims a lock whose recorded pid is no longer running", async () => {
    const path = await lockPath();
    await writeFile(path, JSON.stringify({ pid: 999_999_999, createdAt: "2026-05-22T00:00:00.000Z" }));

    const release = await acquireLock(path);
    const lock = JSON.parse(await readFile(path, "utf8")) as { pid: number };

    expect(lock.pid).toBe(process.pid);
    await release();
  });

  it("keeps an active lock and reports the owning pid", async () => {
    const path = await lockPath();
    await writeFile(path, JSON.stringify({ pid: process.pid, createdAt: "2026-05-22T00:00:00.000Z" }));

    await expect(acquireLock(path)).rejects.toThrow(`live lock is already held by pid ${process.pid}`);
  });

  it("reclaims an old uninspectable lock left by a crash during lock creation", async () => {
    const path = await lockPath();
    await writeFile(path, "{");
    const old = new Date(Date.now() - 60_000);
    await utimes(path, old, old);

    const release = await acquireLock(path);
    const lock = JSON.parse(await readFile(path, "utf8")) as { pid: number };

    expect(lock.pid).toBe(process.pid);
    await release();
  });

  it("does not let an older release remove a newer lock", async () => {
    const path = await lockPath();
    const releaseOld = await acquireLock(path);
    await rm(path, { force: true });
    const releaseNew = await acquireLock(path);

    await releaseOld();

    await expect(readFile(path, "utf8")).resolves.toContain(`"pid":${process.pid}`);
    await releaseNew();
  });
});
