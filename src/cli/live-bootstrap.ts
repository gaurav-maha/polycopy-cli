import { Command } from "commander";
import { chmod, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { openDatabase, type SqliteDatabase } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import type { Config } from "../config/schema.js";

export function emitCliExit(
  program: Command,
  payload: Record<string, unknown>,
  exitCode: number,
  options?: { includeOkFalse?: boolean }
): never {
  if (program.optsWithGlobals().json) {
    const jsonPayload = options?.includeOkFalse ? payload : { ok: false, ...payload };
    process.stdout.write(`${JSON.stringify(jsonPayload)}\n`);
  } else {
    process.stderr.write(`${payload.reason ?? payload.error ?? "command failed"}\n`);
  }
  process.exit(exitCode);
}

export async function isKillSwitchActive(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function chmodIfExists(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export async function confirmLiveSubmission(options?: { bypass?: boolean }): Promise<void> {
  if (options?.bypass) {
    return;
  }
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question("Type LIVE to enable real order submission: ");
    if (answer !== "LIVE") {
      throw new Error("LIVE_PROMPT_ABORTED");
    }
  } finally {
    rl.close();
  }
}

export async function prepareLiveDatabase(paths: {
  dbPath: string;
  logDir: string;
  lockPath: string;
}): Promise<SqliteDatabase> {
  await mkdir(dirname(paths.dbPath), { recursive: true, mode: 0o700 });
  await mkdir(paths.logDir, { recursive: true, mode: 0o700 });
  await mkdir(dirname(paths.lockPath), { recursive: true, mode: 0o700 });
  const db = openDatabase(paths.dbPath);
  runMigrations(db);
  await chmodIfExists(paths.dbPath, 0o600);
  await chmodIfExists(`${paths.dbPath}-wal`, 0o600);
  await chmodIfExists(`${paths.dbPath}-shm`, 0o600);
  return db;
}

export function ciPromptBypass(config: Config): boolean {
  return (
    process.env.LIVE_TEST_CI === "1" &&
    config.live.maxOneLiveOrder &&
    BigInt(config.risk.freeBudgetPusdRaw ?? "1") <= BigInt(config.live.ciTinyBudgetPusdRaw) &&
    Boolean(config.live.credentialLabel) &&
    !/prod|production/i.test(config.live.credentialLabel ?? "")
  );
}
