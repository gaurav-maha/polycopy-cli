import { randomUUID } from "node:crypto";
import type { SignedClobOrder } from "../../adapters/types.js";
import type { SqliteDatabase } from "../../db/client.js";
import { reserveOutboxLeaderBudget } from "../outbox-budget.js";
import { encryptSignedPayload } from "../payload-crypto.js";
import type { PreparedDecision } from "./types.js";

export function createOutboxRow(
  db: SqliteDatabase,
  args: {
    decision: PreparedDecision;
    signedOrder: SignedClobOrder;
    encryptionKey: Uint8Array;
    nowIso: string;
    reservationId: string;
    orderSubmissionId: string;
  }
): string {
  const encrypted = encryptSignedPayload(JSON.stringify(args.signedOrder.payload), args.encryptionKey, {
    aad: args.orderSubmissionId
  });
  runBeginImmediate(db, () => {
    const existing = db
      .prepare("SELECT id FROM order_submissions WHERE copy_decision_id = ?")
      .get(args.decision.id) as { id: string } | undefined;
    if (existing) {
      throw new Error(`copy_decision already has order submission: ${args.decision.id}`);
    }

    db.prepare(
      `
        INSERT INTO risk_reservations (
          id, copy_decision_id, token_id, side,
          p_usd_reserved_raw, p_usd_fee_reserved_raw, inventory_reserved_raw,
          state, source_wallet, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)
      `
    ).run(
      args.reservationId,
      args.decision.id,
      args.decision.token_id,
      args.decision.side,
      args.decision.side === "BUY" ? args.decision.approvedNotionalRaw.toString() : "0",
      args.decision.side === "BUY" ? args.decision.feeHeadroomRaw.toString() : "0",
      args.decision.side === "SELL" ? args.decision.intendedSizeRaw.toString() : "0",
      args.decision.source_wallet,
      args.nowIso
    );
    reserveOutboxLeaderBudget(db, {
      sourceWallet: args.decision.source_wallet,
      reservationId: args.reservationId,
      approvedNotionalRaw: args.decision.approvedNotionalRaw + args.decision.feeHeadroomRaw,
      nowMs: Date.parse(args.nowIso)
    });
    db.prepare(
      `
        INSERT INTO order_submissions (
          id, copy_decision_id, signed_order_hash, encrypted_signed_payload_json,
          current_state, order_type, limit_price_ppm, intended_notional_raw, intended_size_raw,
          created_at, updated_at
        )
        VALUES (?, ?, ?, ?, 'CREATED', ?, ?, ?, ?, ?, ?)
      `
    ).run(
      args.orderSubmissionId,
      args.decision.id,
      args.signedOrder.orderHash,
      encrypted,
      args.decision.orderType,
      String(args.decision.limitPricePpm),
      args.decision.approvedNotionalRaw.toString(),
      args.decision.intendedSizeRaw.toString(),
      args.nowIso,
      args.nowIso
    );
    db.prepare(
      `
        INSERT INTO order_attempts (
          id, order_submission_id, from_state, to_state, action, created_at
        )
        VALUES (?, ?, NULL, 'CREATED', 'CREATED', ?)
      `
    ).run(randomUUID(), args.orderSubmissionId, args.nowIso);
  });
  return args.orderSubmissionId;
}

export function runBeginImmediate<T>(db: SqliteDatabase, fn: () => T): T {
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

export function reservationIdFor(copyDecisionId: string): string {
  return `rr_${copyDecisionId}`;
}

export function orderSubmissionIdFor(copyDecisionId: string): string {
  return `os_${copyDecisionId}`;
}
