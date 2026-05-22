import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "../db/client.js";
import type { OrderSubmissionState, RetryGuardContext } from "./state-machine.js";
import { assertLegalTransition } from "./state-machine.js";
import {
  recordFollowerFillsInOpenTransaction,
  type FollowerFillInput
} from "../reconcile/positions.js";
import { dayUtcFromMs, settleLeaderBudgetReservation, type HexAddress } from "../risk/leader-budgets.js";

export type OrderSubmissionCasTransitionArgs = {
  orderSubmissionId: string;
  from: OrderSubmissionState;
  to: OrderSubmissionState;
  action: string;
  nowIso?: string;
  zeroExposureProof?: boolean;
  retryGuard?: RetryGuardContext;
  requestJsonRedacted?: string | null;
  responseJsonRedacted?: string | null;
  errorCode?: string | null;
  lastError?: string | null;
  incrementRetryCount?: boolean;
  incrementRecoveryAttempts?: boolean;
  followerFills?: FollowerFillInput[];
};

export type OrderSubmissionCasTransitionResult = {
  transitioned: true;
};

const timeoutUnknownGuardedTerminalStates = new Set<OrderSubmissionState>(["ACK_REJECTED", "FAILED", "CANCELLED"]);
const zeroExposureCleanupStates = new Set<OrderSubmissionState>(["ACK_REJECTED", "CANCELLED", "FAILED"]);
const acceptedFillStates = new Set<OrderSubmissionState>(["ACK_FILLED", "ACK_PARTIAL"]);

export function transitionOrderSubmissionCas(
  db: SqliteDatabase,
  args: OrderSubmissionCasTransitionArgs
): OrderSubmissionCasTransitionResult {
  assertLegalTransition(args.from, args.to, args.retryGuard);
  if (args.from === "TIMEOUT_UNKNOWN" && timeoutUnknownGuardedTerminalStates.has(args.to) && !args.zeroExposureProof) {
    throw new Error(`TIMEOUT_UNKNOWN -> ${args.to} requires zeroExposureProof`);
  }

  const nowIso = args.nowIso ?? new Date().toISOString();
  const zeroExposureCleanup = Boolean(args.zeroExposureProof && zeroExposureCleanupStates.has(args.to));
  const acceptedFillAccounting = acceptedFillStates.has(args.to);
  if (acceptedFillAccounting && (!args.followerFills || args.followerFills.length === 0)) {
    throw new Error(`${args.to} requires followerFills accounting`);
  }

  return runBeginImmediate(db, () => {
    const sizeAccounting = acceptedFillAccounting
      ? calculateAcceptedFillSizes(db, args.orderSubmissionId, args.followerFills!)
      : { filledSizeRaw: "0", abandonedSizeRaw: "0" };
    const leaderBudgetSettlement =
      zeroExposureCleanup || acceptedFillAccounting
        ? readLeaderBudgetSettlement(db, args.orderSubmissionId, acceptedFillAccounting ? args.followerFills! : [], nowIso)
        : null;
    const result = db.prepare(
      `
        UPDATE order_submissions
        SET
          current_state = @to,
          filled_size_raw = CASE
            WHEN @zeroExposureCleanup = 1 THEN '0'
            WHEN @acceptedFillAccounting = 1 THEN @filledSizeRaw
            ELSE filled_size_raw
          END,
          abandoned_size_raw = CASE
            WHEN @zeroExposureCleanup = 1 THEN intended_size_raw
            WHEN @acceptedFillAccounting = 1 THEN @abandonedSizeRaw
            ELSE abandoned_size_raw
          END,
          encrypted_signed_payload_json = CASE
            WHEN @zeroExposureCleanup = 1 OR @acceptedFillAccounting = 1 THEN NULL
            ELSE encrypted_signed_payload_json
          END,
          payload_erased_at = CASE
            WHEN @zeroExposureCleanup = 1 OR @acceptedFillAccounting = 1 THEN @nowIso
            ELSE payload_erased_at
          END,
          retry_count = retry_count + @retryIncrement,
          recovery_attempts = recovery_attempts + @recoveryIncrement,
          last_error = CASE WHEN @lastError IS NULL THEN last_error ELSE @lastError END,
          updated_at = @nowIso
        WHERE id = @orderSubmissionId
          AND current_state = @from
      `
    ).run({
      orderSubmissionId: args.orderSubmissionId,
      from: args.from,
      to: args.to,
      zeroExposureCleanup: zeroExposureCleanup ? 1 : 0,
      acceptedFillAccounting: acceptedFillAccounting ? 1 : 0,
      filledSizeRaw: sizeAccounting.filledSizeRaw,
      abandonedSizeRaw: sizeAccounting.abandonedSizeRaw,
      retryIncrement: args.incrementRetryCount ? 1 : 0,
      recoveryIncrement: args.incrementRecoveryAttempts ? 1 : 0,
      lastError: args.lastError ?? null,
      nowIso
    });

    if (result.changes !== 1) {
      throw new Error(`CAS transition failed for order submission ${args.orderSubmissionId}: expected ${args.from}`);
    }

    if (acceptedFillAccounting) {
      recordFollowerFillsInOpenTransaction(db, { fills: args.followerFills! });
    }

    if (zeroExposureCleanup || acceptedFillAccounting) {
      db.prepare(
        `
          UPDATE risk_reservations
          SET state = 'RELEASED',
              released_at = @nowIso
          WHERE copy_decision_id = (
            SELECT copy_decision_id
            FROM order_submissions
            WHERE id = @orderSubmissionId
          )
            AND state = 'ACTIVE'
        `
      ).run({ orderSubmissionId: args.orderSubmissionId, nowIso });
      if (leaderBudgetSettlement) {
        settleLeaderBudgetReservation(db, leaderBudgetSettlement);
      }
    }

    db.prepare(
      `
        INSERT INTO order_attempts (
          id, order_submission_id, from_state, to_state, action,
          request_json_redacted, response_json_redacted, error_code, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      randomUUID(),
      args.orderSubmissionId,
      args.from,
      args.to,
      args.action,
      args.requestJsonRedacted ?? null,
      args.responseJsonRedacted ?? null,
      args.errorCode ?? null,
      nowIso
    );

    return { transitioned: true };
  });
}

function readLeaderBudgetSettlement(
  db: SqliteDatabase,
  orderSubmissionId: string,
  followerFills: FollowerFillInput[],
  nowIso: string
): { sourceWallet: HexAddress; dayUtc: string; reservedRaw: bigint; realizedRaw: bigint; nowIso: string } | null {
  const row = db
    .prepare(
      `
        SELECT rr.source_wallet, rr.p_usd_reserved_raw, rr.p_usd_fee_reserved_raw, rr.created_at
        FROM risk_reservations rr
        WHERE rr.copy_decision_id = (
          SELECT copy_decision_id
          FROM order_submissions
          WHERE id = ?
        )
          AND rr.state = 'ACTIVE'
        LIMIT 1
      `
    )
    .get(orderSubmissionId) as
    | { source_wallet: HexAddress | null; p_usd_reserved_raw: string; p_usd_fee_reserved_raw: string; created_at: string }
    | undefined;
  if (!row?.source_wallet) return null;
  const reservedRaw = BigInt(row.p_usd_reserved_raw) + BigInt(row.p_usd_fee_reserved_raw);
  const spendRaw = followerFills.reduce((total, fill) => {
    const delta = BigInt(fill.pUsdDeltaRaw);
    return delta < 0n ? total - delta : total;
  }, 0n);
  const feeRaw = followerFills.reduce((total, fill) => total + BigInt(fill.feeRaw), 0n);
  const totalSpendRaw = spendRaw + feeRaw;
  const realizedRaw = totalSpendRaw > reservedRaw ? reservedRaw : totalSpendRaw;
  return {
    sourceWallet: row.source_wallet,
    dayUtc: dayUtcForReservation(row.created_at, nowIso),
    reservedRaw,
    realizedRaw,
    nowIso
  };
}

function dayUtcForReservation(createdAt: string, fallbackIso: string): string {
  const ms = Date.parse(createdAt);
  if (Number.isFinite(ms)) return dayUtcFromMs(ms);
  return fallbackIso.slice(0, 10);
}

function calculateAcceptedFillSizes(
  db: SqliteDatabase,
  orderSubmissionId: string,
  followerFills: FollowerFillInput[]
): { filledSizeRaw: string; abandonedSizeRaw: string } {
  if (followerFills.some((fill) => fill.orderSubmissionId !== orderSubmissionId)) {
    throw new Error("followerFills must all belong to the transitioned order submission");
  }
  const row = db
    .prepare("SELECT intended_size_raw FROM order_submissions WHERE id = ?")
    .get(orderSubmissionId) as { intended_size_raw: string } | undefined;
  if (!row) {
    throw new Error(`Order submission not found: ${orderSubmissionId}`);
  }
  const filled = followerFills.reduce((total, fill) => total + BigInt(fill.sizeRaw), 0n);
  const intended = BigInt(row.intended_size_raw);
  return {
    filledSizeRaw: filled.toString(),
    abandonedSizeRaw: filled >= intended ? "0" : (intended - filled).toString()
  };
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
