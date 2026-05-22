import type { Hex } from "../../adapters/types.js";
import type { SqliteDatabase } from "../../db/client.js";
import {
  parseGateSnapshot,
  readBoolean,
  readNumber,
  readOptionalNumber,
  readRecord,
  readString,
  tickSizeToPpm
} from "./gate-snapshot.js";
import type { CopyDecisionRow, PreparedDecision } from "./types.js";
import { estimateBuyPusdFeeHeadroomRaw, type BuyFeeConfig } from "../../risk/fee-headroom.js";

export function readEligibleDecisions(
  db: SqliteDatabase,
  args: { leaders?: Hex[]; limit: number }
): CopyDecisionRow[] {
  const leaderFilter = args.leaders?.map((leader) => leader.toLowerCase());
  const rows = db
    .prepare(
      `
        SELECT
          cd.id,
          cd.source_wallet,
          cd.token_id,
          cd.side,
          cd.contract_address,
          cd.approved_copy_notional_raw,
          cd.intended_copy_notional_raw,
          cd.gate_snapshot_json,
          cd.created_at
        FROM copy_decisions cd
        LEFT JOIN order_submissions os ON os.copy_decision_id = cd.id
        WHERE cd.status = 'ACTIVE'
          AND cd.approved_copy_notional_raw IS NOT NULL
          AND os.id IS NULL
        ORDER BY datetime(cd.created_at), cd.created_at, cd.id
      `
    )
    .all() as CopyDecisionRow[];
  const filtered = leaderFilter
    ? rows.filter((row) => leaderFilter.includes(row.source_wallet.toLowerCase()))
    : rows;
  return filtered.slice(0, Math.max(0, args.limit));
}

export function prepareDecision(decision: CopyDecisionRow): PreparedDecision {
  const snapshot = parseGateSnapshot(decision.gate_snapshot_json);
  const book = readRecord(snapshot.book, "gate_snapshot_json.book");
  const metadata = readRecord(snapshot.metadata, "gate_snapshot_json.metadata");
  const leaderPricePpm = readOptionalNumber(snapshot.leaderPricePpm) ?? readNumber(book.vwapPpm, "gate_snapshot_json.book.vwapPpm");
  const tickSize = readString(metadata.tickSize, "gate_snapshot_json.metadata.tickSize");
  const approvedNotionalRaw = BigInt(decision.approved_copy_notional_raw);
  const limitPricePpm = readNumber(snapshot.limitPpm, "gate_snapshot_json.limitPpm");
  const feeConfig = readOptionalFeeConfig(metadata.feeConfig);
  return {
    ...decision,
    approvedNotionalRaw,
    intendedSizeRaw: BigInt(readString(book.intendedSizeRaw, "gate_snapshot_json.book.intendedSizeRaw")),
    feeHeadroomRaw:
      decision.side === "BUY"
        ? estimateBuyPusdFeeHeadroomRaw({ notionalRaw: approvedNotionalRaw, limitPricePpm, feeConfig })
        : 0n,
    ...(feeConfig ? { feeConfig } : {}),
    leaderPricePpm,
    tickSizePpm: tickSizeToPpm(tickSize),
    limitPricePpm,
    tickSize,
    negRisk: readBoolean(metadata.negRisk, "gate_snapshot_json.metadata.negRisk"),
    orderType: "FAK"
  };
}

export function refreshPreparedBuyFeeHeadroom(decision: PreparedDecision): void {
  decision.feeHeadroomRaw =
    decision.side === "BUY"
      ? estimateBuyPusdFeeHeadroomRaw({
          notionalRaw: decision.approvedNotionalRaw,
          limitPricePpm: decision.limitPricePpm,
          feeConfig: decision.feeConfig
        })
      : 0n;
}

function readOptionalFeeConfig(value: unknown): BuyFeeConfig | undefined {
  if (value === undefined || value === null) return undefined;
  const record = readRecord(value, "gate_snapshot_json.metadata.feeConfig");
  return {
    r: readString(record.r, "gate_snapshot_json.metadata.feeConfig.r"),
    e: readString(record.e, "gate_snapshot_json.metadata.feeConfig.e"),
    to: readString(record.to, "gate_snapshot_json.metadata.feeConfig.to")
  };
}

export function skipDecision(
  db: SqliteDatabase,
  decisionId: string,
  skipReason: string,
  nowIso: string,
  signBoundarySnapshot?: Record<string, unknown>
): void {
  if (signBoundarySnapshot) {
    const row = db.prepare("SELECT gate_snapshot_json FROM copy_decisions WHERE id = ?").get(decisionId) as
      | { gate_snapshot_json: string }
      | undefined;
    const merged = row
      ? JSON.stringify({
          ...JSON.parse(row.gate_snapshot_json),
          signBoundary: signBoundarySnapshot
        })
      : JSON.stringify({ signBoundary: signBoundarySnapshot });
    db.prepare(
      `
        UPDATE copy_decisions
        SET status = 'SKIPPED',
            skip_reason = ?,
            gate_snapshot_json = ?,
            updated_at = ?
        WHERE id = ?
      `
    ).run(skipReason, merged, nowIso, decisionId);
    return;
  }
  db.prepare(
    `
      UPDATE copy_decisions
      SET status = 'SKIPPED',
          skip_reason = ?,
          updated_at = ?
      WHERE id = ?
    `
  ).run(skipReason, nowIso, decisionId);
}

export function markDecisionError(db: SqliteDatabase, decisionId: string, errorReason: string, nowIso: string): void {
  db.prepare(
    `
      UPDATE copy_decisions
      SET status = 'ERROR',
          error_reason = ?,
          updated_at = ?
      WHERE id = ?
    `
  ).run(errorReason, nowIso, decisionId);
}

export function haltLive(db: SqliteDatabase, reason: string, orderSubmissionId: string, nowIso: string): void {
  db.prepare(
    `
      INSERT OR REPLACE INTO runtime_state (key, value, updated_at)
      VALUES (?, ?, ?)
    `
  ).run(`live_halt.${reason}`, JSON.stringify({ reason, orderSubmissionId, at: nowIso }), nowIso);
}

export function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
