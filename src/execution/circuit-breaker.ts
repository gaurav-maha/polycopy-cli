import type { SqliteDatabase } from "../db/client.js";

export type BreakerThresholds = {
  consecutiveRejectionsHalt: number;
  consecutiveTimeoutUnknownHalt: number;
  staleBookHalt: number;
  bookSourceMismatchHalt: number;
  clobUnavailableHalt: number;
};

export type LiveCycleBreakerInput = {
  rejected: number;
  timeoutUnknown: number;
  staleAtSign: number;
  bookSourceMismatch: number;
  clobUnavailable: number;
  cacheMismatch: number;
  reconciled: number;
  recoveryTerminal: number;
};

const consecutiveBreakers = new Set(["REJECTION", "TIMEOUT_UNKNOWN", "STALE_BOOK", "BOOK_SOURCE_MISMATCH", "CLOB_UNAVAILABLE"]);

const immediateHaltBreakers = new Set([
  "RPC_DISAGREEMENT",
  "BOOK_GAP",
  "CACHE_MISMATCH",
  "QUEUE_OVERFLOW",
  "RECONCILIATION_DIVERGENCE",
  "CLOCK_SKEW"
]);

export type CircuitBreakerSnapshot = {
  breaker: string;
  threshold: number;
  currentCount: number;
  lastEventAt: string;
  resetReason: string | null;
};

export function readCircuitBreaker(db: SqliteDatabase, breaker: string): CircuitBreakerSnapshot | null {
  const row = db.prepare("SELECT value FROM runtime_state WHERE key = ?").get(`circuit_breaker.${breaker}`) as
    | { value: string }
    | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as CircuitBreakerSnapshot;
    if (typeof parsed.currentCount !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function tripCircuitBreaker(
  db: SqliteDatabase,
  breaker: string,
  args: { threshold: number; nowIso: string; increment?: number }
): CircuitBreakerSnapshot {
  const existing = readCircuitBreaker(db, breaker);
  const snapshot: CircuitBreakerSnapshot = {
    breaker,
    threshold: args.threshold,
    currentCount: (existing?.currentCount ?? 0) + (args.increment ?? 1),
    lastEventAt: args.nowIso,
    resetReason: null
  };
  db.prepare(
    `
      INSERT OR REPLACE INTO runtime_state (key, value, updated_at)
      VALUES (?, ?, ?)
    `
  ).run(`circuit_breaker.${breaker}`, JSON.stringify(snapshot), args.nowIso);
  return snapshot;
}

export function resetCircuitBreaker(
  db: SqliteDatabase,
  breaker: string,
  args: { threshold: number; nowIso: string; resetReason: string }
): void {
  const snapshot: CircuitBreakerSnapshot = {
    breaker,
    threshold: args.threshold,
    currentCount: 0,
    lastEventAt: args.nowIso,
    resetReason: args.resetReason
  };
  db.prepare(
    `
      INSERT OR REPLACE INTO runtime_state (key, value, updated_at)
      VALUES (?, ?, ?)
    `
  ).run(`circuit_breaker.${breaker}`, JSON.stringify(snapshot), args.nowIso);
}

export function recordConsecutiveBreakerEvent(
  db: SqliteDatabase,
  breaker: string,
  args: { threshold: number; nowIso: string; increment?: number }
): { tripped: boolean; snapshot: CircuitBreakerSnapshot } {
  const snapshot = tripCircuitBreaker(db, breaker, args);
  return { tripped: snapshot.currentCount >= snapshot.threshold, snapshot };
}

export function tripImmediateHaltBreaker(
  db: SqliteDatabase,
  breaker: string,
  args: { nowIso: string; details?: Record<string, unknown> }
): void {
  tripCircuitBreaker(db, breaker, { threshold: 1, nowIso: args.nowIso });
  haltLiveTrading(db, breaker, args.details ?? {}, args.nowIso);
}

export function resetConsecutiveBreakersAfterReconciliation(
  db: SqliteDatabase,
  thresholds: BreakerThresholds,
  nowIso: string
): void {
  for (const breaker of consecutiveBreakers) {
    const threshold = thresholdForBreaker(breaker, thresholds);
    if (readCircuitBreaker(db, breaker)?.currentCount) {
      resetCircuitBreaker(db, breaker, { threshold, nowIso, resetReason: "successful_reconciliation" });
    }
  }
}

export function evaluateLiveCycleBreakers(
  db: SqliteDatabase,
  thresholds: BreakerThresholds,
  input: LiveCycleBreakerInput,
  nowIso: string
): { halted: boolean; haltReason: string | null } {
  if (input.cacheMismatch > 0) {
    tripImmediateHaltBreaker(db, "CACHE_MISMATCH", { nowIso, details: { count: input.cacheMismatch } });
    return { halted: true, haltReason: "CACHE_MISMATCH" };
  }

  if (input.reconciled > 0 || input.recoveryTerminal > 0) {
    resetConsecutiveBreakersAfterReconciliation(db, thresholds, nowIso);
  }

  const events: Array<[breaker: string, count: number, threshold: number]> = [
    ["REJECTION", input.rejected, thresholds.consecutiveRejectionsHalt],
    ["TIMEOUT_UNKNOWN", input.timeoutUnknown, thresholds.consecutiveTimeoutUnknownHalt],
    ["STALE_BOOK", input.staleAtSign, thresholds.staleBookHalt],
    ["BOOK_SOURCE_MISMATCH", input.bookSourceMismatch, thresholds.bookSourceMismatchHalt],
    ["CLOB_UNAVAILABLE", input.clobUnavailable, thresholds.clobUnavailableHalt]
  ];

  for (const [breaker, count, threshold] of events) {
    if (count <= 0) continue;
    const result = recordConsecutiveBreakerEvent(db, breaker, { threshold, nowIso, increment: count });
    if (result.tripped) {
      haltLiveTrading(db, breaker, { count: result.snapshot.currentCount }, nowIso);
      return { halted: true, haltReason: breaker };
    }
  }

  return { halted: false, haltReason: null };
}

export function readLiveHaltReason(db: SqliteDatabase): string | null {
  const rows = db
    .prepare(
      `
        SELECT key, value
        FROM runtime_state
        WHERE key LIKE 'live_halt.%'
           OR key LIKE 'circuit_breaker.%'
           OR key = 'live_halt_reconciliation_divergence'
        ORDER BY
          CASE
            WHEN key LIKE 'live_halt.%' THEN 0
            WHEN key = 'live_halt_reconciliation_divergence' THEN 1
            ELSE 2
          END,
          key
      `
    )
    .all() as Array<{ key: string; value: string }>;
  for (const row of rows) {
    if (row.key.startsWith("live_halt.")) {
      return row.key.slice("live_halt.".length);
    }
    if (row.key === "live_halt_reconciliation_divergence") {
      return "RECONCILIATION_DIVERGENCE";
    }
    if (row.key.startsWith("circuit_breaker.")) {
      const breaker = row.key.slice("circuit_breaker.".length);
      const snapshot = readCircuitBreaker(db, breaker);
      if (snapshot && snapshot.currentCount >= snapshot.threshold && immediateHaltBreakers.has(breaker)) {
        return breaker;
      }
    }
  }
  for (const row of rows) {
    if (!row.key.startsWith("circuit_breaker.")) continue;
    const breaker = row.key.slice("circuit_breaker.".length);
    const snapshot = readCircuitBreaker(db, breaker);
    if (snapshot && snapshot.currentCount >= snapshot.threshold) {
      return breaker;
    }
  }
  return null;
}

export function haltLiveTrading(db: SqliteDatabase, reason: string, details: Record<string, unknown>, nowIso: string): void {
  db.prepare(
    `
      INSERT OR REPLACE INTO runtime_state (key, value, updated_at)
      VALUES (?, ?, ?)
    `
  ).run(`live_halt.${reason}`, JSON.stringify({ reason, ...details, at: nowIso }), nowIso);
}

function thresholdForBreaker(breaker: string, thresholds: BreakerThresholds): number {
  switch (breaker) {
    case "REJECTION":
      return thresholds.consecutiveRejectionsHalt;
    case "TIMEOUT_UNKNOWN":
      return thresholds.consecutiveTimeoutUnknownHalt;
    case "STALE_BOOK":
      return thresholds.staleBookHalt;
    case "BOOK_SOURCE_MISMATCH":
      return thresholds.bookSourceMismatchHalt;
    case "CLOB_UNAVAILABLE":
      return thresholds.clobUnavailableHalt;
    default:
      return 1;
  }
}

export function breakerThresholdsFromConfig(risk: BreakerThresholds): BreakerThresholds {
  return risk;
}
