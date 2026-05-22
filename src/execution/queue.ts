import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "../db/client.js";
import { dayUtcFromMs, settleLeaderBudgetReservation, type HexAddress } from "../risk/leader-budgets.js";
import type { OrderSubmissionState, Transition } from "./state-machine.js";
import { transitionOrderSubmissionState } from "./state-machine.js";

export type PendingSubmissionRow = {
  id: string;
  copyDecisionId: string;
  currentState: string;
  createdAt: string;
  intendedSizeRaw: string;
};

export type QueueOverflowCleanupAction = {
  orderSubmissionId: string;
  copyDecisionId: string;
  transition: Transition;
  decision: { status: "SKIPPED"; skipReason: "QUEUE_OVERFLOW" };
  releaseReservation: true;
  erasePayload: true;
  deleteRow: false;
};

export type QueueOverflowSqliteCleanupResult = {
  overflow: boolean;
  cancelledOrderSubmissionIds: string[];
  currentDecisionSkipped: boolean;
  circuitBreaker: null | "QUEUE_OVERFLOW";
};

export function planQueueOverflowCleanup(
  rows: PendingSubmissionRow[],
  args: { maxPendingSubmissions: number; incomingSubmissions: number }
): {
  overflow: boolean;
  cleanupActions: QueueOverflowCleanupAction[];
  currentDecisionSkip: null | { status: "SKIPPED"; skipReason: "QUEUE_OVERFLOW" };
  circuitBreaker: null | "QUEUE_OVERFLOW";
} {
  const pendingCount = rows.length + args.incomingSubmissions;
  if (pendingCount <= args.maxPendingSubmissions) {
    return { overflow: false, cleanupActions: [], currentDecisionSkip: null, circuitBreaker: null };
  }
  const createdRows = rows
    .filter((row) => row.currentState === "CREATED")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(0, pendingCount - args.maxPendingSubmissions);
  return {
    overflow: true,
    cleanupActions: createdRows.map((row) => ({
      orderSubmissionId: row.id,
      copyDecisionId: row.copyDecisionId,
      transition: transitionOrderSubmissionState("CREATED", "CANCELLED" as OrderSubmissionState),
      decision: { status: "SKIPPED", skipReason: "QUEUE_OVERFLOW" },
      releaseReservation: true,
      erasePayload: true,
      deleteRow: false
    })),
    currentDecisionSkip: { status: "SKIPPED", skipReason: "QUEUE_OVERFLOW" },
    circuitBreaker: "QUEUE_OVERFLOW"
  };
}

type CreatedOrderRow = {
  id: string;
  copyDecisionId: string;
};

const pendingQueueStates = ["CREATED", "SUBMITTING", "SUBMITTED", "TIMEOUT_UNKNOWN"] as const;

export function cleanupQueueOverflowCreatedRows(
  db: SqliteDatabase,
  args: {
    maxPendingSubmissions: number;
    incomingDecisionId: string;
    incomingSubmissions?: number;
    nowIso?: string;
  }
): QueueOverflowSqliteCleanupResult {
  if (args.maxPendingSubmissions < 0) {
    throw new Error("maxPendingSubmissions must be non-negative");
  }

  const incomingSubmissions = args.incomingSubmissions ?? 1;
  const nowIso = args.nowIso ?? new Date().toISOString();

  return runBeginImmediate(db, () => {
    const pendingCount = readPendingSubmissionCount(db);
    const overflowCount = pendingCount + incomingSubmissions - args.maxPendingSubmissions;

    if (overflowCount <= 0) {
      return {
        overflow: false,
        cancelledOrderSubmissionIds: [],
        currentDecisionSkipped: false,
        circuitBreaker: null
      };
    }

    const createdRows = db.prepare(
      `
        SELECT id, copy_decision_id AS copyDecisionId
        FROM order_submissions
        WHERE current_state = 'CREATED'
        ORDER BY datetime(created_at), created_at, id
        LIMIT ?
      `
    ).all(overflowCount) as CreatedOrderRow[];

    for (const row of createdRows) {
      cancelCreatedOrderForQueueOverflow(db, row, nowIso);
    }

    const currentDecision = db.prepare(
      `
        UPDATE copy_decisions
        SET status = 'SKIPPED',
            skip_reason = 'QUEUE_OVERFLOW',
            updated_at = ?
        WHERE id = ?
      `
    ).run(nowIso, args.incomingDecisionId);

    if (currentDecision.changes !== 1) {
      throw new Error(`Current decision not found for queue overflow: ${args.incomingDecisionId}`);
    }

    tripQueueOverflowCircuitBreaker(db, nowIso);

    return {
      overflow: true,
      cancelledOrderSubmissionIds: createdRows.map((row) => row.id),
      currentDecisionSkipped: true,
      circuitBreaker: "QUEUE_OVERFLOW"
    };
  });
}

function readPendingSubmissionCount(db: SqliteDatabase): number {
  const placeholders = pendingQueueStates.map(() => "?").join(", ");
  const row = db.prepare(
    `
      SELECT COUNT(*) AS count
      FROM order_submissions
      WHERE current_state IN (${placeholders})
    `
  ).get(...pendingQueueStates) as { count: number };
  return row.count;
}

function cancelCreatedOrderForQueueOverflow(db: SqliteDatabase, row: CreatedOrderRow, nowIso: string): void {
  const leaderBudgetSettlement = readLeaderBudgetSettlementForCopyDecision(db, row.copyDecisionId, nowIso);
  const result = db.prepare(
    `
      UPDATE order_submissions
      SET current_state = 'CANCELLED',
          filled_size_raw = '0',
          abandoned_size_raw = intended_size_raw,
          encrypted_signed_payload_json = NULL,
          payload_erased_at = ?,
          updated_at = ?
      WHERE id = ?
        AND current_state = 'CREATED'
    `
  ).run(nowIso, nowIso, row.id);

  if (result.changes !== 1) {
    throw new Error(`Queue overflow CAS failed for CREATED order submission ${row.id}`);
  }

  db.prepare(
    `
      UPDATE copy_decisions
      SET status = 'SKIPPED',
          skip_reason = 'QUEUE_OVERFLOW',
          updated_at = ?
      WHERE id = ?
    `
  ).run(nowIso, row.copyDecisionId);

  db.prepare(
    `
      UPDATE risk_reservations
      SET state = 'RELEASED',
          released_at = ?
      WHERE copy_decision_id = ?
        AND state = 'ACTIVE'
    `
  ).run(nowIso, row.copyDecisionId);
  if (leaderBudgetSettlement) {
    settleLeaderBudgetReservation(db, leaderBudgetSettlement);
  }

  db.prepare(
    `
      INSERT INTO order_attempts (
        id, order_submission_id, from_state, to_state, action, error_code, created_at
      )
      VALUES (?, ?, 'CREATED', 'CANCELLED', 'QUEUE_OVERFLOW_CANCEL', 'QUEUE_OVERFLOW', ?)
    `
  ).run(randomUUID(), row.id, nowIso);
}

function readLeaderBudgetSettlementForCopyDecision(
  db: SqliteDatabase,
  copyDecisionId: string,
  nowIso: string
): { sourceWallet: HexAddress; dayUtc: string; reservedRaw: bigint; realizedRaw: bigint; nowIso: string } | null {
  const row = db
    .prepare(
      `
        SELECT source_wallet, p_usd_reserved_raw, created_at
        FROM risk_reservations
        WHERE copy_decision_id = ?
          AND state = 'ACTIVE'
        LIMIT 1
      `
    )
    .get(copyDecisionId) as
    | { source_wallet: HexAddress | null; p_usd_reserved_raw: string; created_at: string }
    | undefined;
  if (!row?.source_wallet) return null;
  const createdAtMs = Date.parse(row.created_at);
  return {
    sourceWallet: row.source_wallet,
    dayUtc: dayUtcFromMs(Number.isFinite(createdAtMs) ? createdAtMs : Date.parse(nowIso)),
    reservedRaw: BigInt(row.p_usd_reserved_raw),
    realizedRaw: 0n,
    nowIso
  };
}

function tripQueueOverflowCircuitBreaker(db: SqliteDatabase, nowIso: string): void {
  const key = "circuit_breaker.QUEUE_OVERFLOW";
  const existing = db.prepare("SELECT value FROM runtime_state WHERE key = ?").get(key) as { value: string } | undefined;
  const currentCount = readCurrentCircuitBreakerCount(existing?.value) + 1;
  const value = JSON.stringify({
    breaker: "QUEUE_OVERFLOW",
    threshold: 1,
    currentCount,
    lastEventAt: nowIso,
    resetReason: null
  });

  db.prepare(
    `
      INSERT OR REPLACE INTO runtime_state (key, value, updated_at)
      VALUES (?, ?, ?)
    `
  ).run(key, value, nowIso);
}

function readCurrentCircuitBreakerCount(value: string | undefined): number {
  if (value === undefined) {
    return 0;
  }
  try {
    const parsed = JSON.parse(value) as { currentCount?: unknown };
    return typeof parsed.currentCount === "number" && Number.isFinite(parsed.currentCount) ? parsed.currentCount : 0;
  } catch {
    return 0;
  }
}

function runBeginImmediate<T>(db: SqliteDatabase, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
