import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import {
  evaluateLiveCycleBreakers,
  haltLiveTrading,
  readLiveHaltReason,
  recordConsecutiveBreakerEvent,
  resetConsecutiveBreakersAfterReconciliation
} from "../../src/execution/circuit-breaker.js";

describe("circuit breaker loop", () => {
  it("trips immediate halt on cache mismatch", async () => {
    const db = await openTestDb();
    const nowIso = new Date().toISOString();
    const result = evaluateLiveCycleBreakers(
      db,
      thresholds(),
      {
        rejected: 0,
        timeoutUnknown: 0,
        staleAtSign: 0,
        bookSourceMismatch: 0,
        clobUnavailable: 0,
        cacheMismatch: 1,
        reconciled: 0,
        recoveryTerminal: 0
      },
      nowIso
    );
    expect(result).toEqual({ halted: true, haltReason: "CACHE_MISMATCH" });
    expect(readLiveHaltReason(db)).toBe("CACHE_MISMATCH");
    db.close();
  });

  it("resets consecutive breakers after successful reconciliation", async () => {
    const db = await openTestDb();
    const nowIso = new Date().toISOString();
    recordConsecutiveBreakerEvent(db, "REJECTION", { threshold: 5, nowIso });
    recordConsecutiveBreakerEvent(db, "REJECTION", { threshold: 5, nowIso });
    resetConsecutiveBreakersAfterReconciliation(db, thresholds(), nowIso);
    const breaker = evaluateLiveCycleBreakers(
      db,
      thresholds(),
      {
        rejected: 1,
        timeoutUnknown: 0,
        staleAtSign: 0,
        bookSourceMismatch: 0,
        clobUnavailable: 0,
        cacheMismatch: 0,
        reconciled: 0,
        recoveryTerminal: 0
      },
      nowIso
    );
    expect(breaker.halted).toBe(false);
    db.close();
  });

  it("reads the legacy reconciliation divergence halt key", async () => {
    const db = await openTestDb();
    db.prepare("INSERT INTO runtime_state (key, value, updated_at) VALUES (?, ?, ?)").run(
      "live_halt_reconciliation_divergence",
      JSON.stringify({ status: "DIVERGED" }),
      "2026-05-22T12:00:00.000Z"
    );

    expect(readLiveHaltReason(db)).toBe("RECONCILIATION_DIVERGENCE");
    db.close();
  });

  it("prefers canonical live halt keys over legacy halt keys", async () => {
    const db = await openTestDb();
    db.prepare("INSERT INTO runtime_state (key, value, updated_at) VALUES (?, ?, ?)").run(
      "live_halt_reconciliation_divergence",
      JSON.stringify({ status: "DIVERGED" }),
      "2026-05-22T12:00:00.000Z"
    );
    haltLiveTrading(db, "CLOB_GEO_BLOCKED", {}, "2026-05-22T12:00:01.000Z");

    expect(readLiveHaltReason(db)).toBe("CLOB_GEO_BLOCKED");
    db.close();
  });
});

async function openTestDb() {
  const dir = await mkdtemp(join(tmpdir(), "polycopy-breaker-"));
  await chmod(dir, 0o700);
  const dbPath = join(dir, "breaker.db");
  await writeFile(dbPath, "", { mode: 0o600 });
  const db = openDatabase(dbPath);
  runMigrations(db);
  return db;
}

function thresholds() {
  return {
    consecutiveRejectionsHalt: 5,
    consecutiveTimeoutUnknownHalt: 3,
    staleBookHalt: 5,
    bookSourceMismatchHalt: 3,
    clobUnavailableHalt: 3
  };
}
