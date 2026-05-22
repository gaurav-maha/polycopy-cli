import { createHash } from "node:crypto";
import type { SqliteDatabase } from "../db/client.js";
import type { Hex, RpcAdapter } from "../adapters/types.js";
import type { DecodedOrderFilled } from "../protocol/decode-order-filled.js";
import type { RawOrderFilledLog } from "../protocol/decode-order-filled.js";
import { decodeOrderFilledLog } from "../protocol/decode-order-filled.js";
import type { FillWithId } from "../normalize/aggregate.js";
import { normalizeSourceFill } from "../normalize/taker-filter.js";
import { CTF_EXCHANGE_V2, NEG_RISK_CTF_EXCHANGE_V2 } from "../constants/chain.js";

function jsonStringify(value: unknown): string {
  return JSON.stringify(value, (_, entry) => (typeof entry === "bigint" ? entry.toString() : entry));
}

export function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex")}`;
}

export function sourceFillId(fill: Pick<DecodedOrderFilled, "contractAddress" | "blockHash" | "txHash" | "logIndex">): string {
  return stableId("sf", `${fill.contractAddress}|${fill.blockHash}|${fill.txHash}|${fill.logIndex}`);
}

export function ensureProcessedBlock(
  db: SqliteDatabase,
  args: { blockNumber: bigint; blockHash: Hex; timestampMs: number; logCount: number }
): void {
  db.prepare(
    `
      INSERT OR IGNORE INTO processed_blocks (id, chain_id, block_number, block_hash, block_timestamp_ms, status, log_count)
      VALUES (?, 137, ?, ?, ?, 'ACTIVE', ?)
    `
  ).run(stableId("pb", args.blockHash), Number(args.blockNumber), args.blockHash, args.timestampMs, args.logCount);
}

export function insertPendingSourceFill(
  db: SqliteDatabase,
  decoded: DecodedOrderFilled,
  raw: RawOrderFilledLog
): { id: string; inserted: boolean } {
  const id = sourceFillId(decoded);
  const result = db
    .prepare(
      `
      INSERT OR IGNORE INTO source_fills (
        id, chain_id, contract_address, block_number, block_hash, tx_hash, tx_index, log_index,
        status, raw_log_json, decoded_json, source_wallet, side, token_id,
        maker_amount_filled_raw, taker_amount_filled_raw, fee_raw, price_ppm
      ) VALUES (
        @id, 137, @contractAddress, @blockNumber, @blockHash, @txHash, @txIndex, @logIndex,
        'PENDING', @rawLogJson, @decodedJson, @sourceWallet, @side, @tokenId,
        @makerAmountFilledRaw, @takerAmountFilledRaw, @feeRaw, @pricePpm
      )
    `
    )
    .run({
      id,
      contractAddress: decoded.contractAddress,
      blockNumber: Number(decoded.blockNumber),
      blockHash: decoded.blockHash,
      txHash: decoded.txHash,
      txIndex: decoded.txIndex,
      logIndex: decoded.logIndex,
      rawLogJson: jsonStringify(raw),
      decodedJson: jsonStringify(decoded),
      sourceWallet: decoded.maker,
      side: decoded.side,
      tokenId: decoded.tokenId,
      makerAmountFilledRaw: decoded.makerAmountFilledRaw,
      takerAmountFilledRaw: decoded.takerAmountFilledRaw,
      feeRaw: decoded.feeRaw,
      pricePpm: decoded.pricePpm
    });
  return { id, inserted: result.changes > 0 };
}

export type PromotedFill = FillWithId;

export function markReorgedBlocks(db: SqliteDatabase, blockNumbers: number[]): number {
  if (blockNumbers.length === 0) return 0;
  const placeholders = blockNumbers.map(() => "?").join(", ");
  db.prepare(
    `UPDATE processed_blocks SET status = 'REORGED', reorged_at = datetime('now') WHERE chain_id = 137 AND block_number IN (${placeholders}) AND status = 'ACTIVE'`
  ).run(...blockNumbers);
  const result = db.prepare(
    `UPDATE source_fills SET status = 'REORGED', updated_at = datetime('now') WHERE status = 'PENDING' AND block_number IN (${placeholders})`
  ).run(...blockNumbers);
  return result.changes;
}

export type ReorgCascadeSummary = {
  rollbackFromBlock: number;
  reorgedBlocks: number;
  reorgedSourceFills: number;
  reorgedAggregationGroups: number;
  skippedReorgDecisions: number;
  postReorgOrphans: number;
  cancelledCreatedOrders: number;
  submitUnknownOrders: number;
  releasedReservations: number;
  liveHalted: boolean;
};

type AffectedDecisionRow = {
  decision_id: string;
  order_id: string | null;
  current_state: string | null;
  intended_size_raw: string | null;
  fill_count: number;
};

function appendOrderAttempt(
  db: SqliteDatabase,
  args: { orderId: string; fromState: string | null; toState: string; action: string; errorCode?: string }
): void {
  db.prepare(
    `
      INSERT INTO order_attempts (id, order_submission_id, from_state, to_state, action, error_code)
      VALUES (?, ?, ?, ?, ?, ?)
    `
  ).run(
    stableId("oa", `${args.orderId}|${args.fromState ?? ""}|${args.toState}|${args.action}|${Date.now()}`),
    args.orderId,
    args.fromState,
    args.toState,
    args.action,
    args.errorCode ?? null
  );
}

export function cascadeReorg(
  db: SqliteDatabase,
  args: { rollbackFromBlock: number; cursorBefore: number; safeHead: number }
): ReorgCascadeSummary {
  const transaction = db.transaction(() => {
    const summary: ReorgCascadeSummary = {
      rollbackFromBlock: args.rollbackFromBlock,
      reorgedBlocks: 0,
      reorgedSourceFills: 0,
      reorgedAggregationGroups: 0,
      skippedReorgDecisions: 0,
      postReorgOrphans: 0,
      cancelledCreatedOrders: 0,
      submitUnknownOrders: 0,
      releasedReservations: 0,
      liveHalted: false
    };

    summary.reorgedBlocks = db
      .prepare(
        `
          UPDATE processed_blocks
          SET status = 'REORGED', reorged_at = datetime('now')
          WHERE chain_id = 137 AND status = 'ACTIVE' AND block_number >= ?
        `
      )
      .run(args.rollbackFromBlock).changes;

    summary.reorgedSourceFills = db
      .prepare(
        `
          UPDATE source_fills
          SET status = 'REORGED', updated_at = datetime('now')
          WHERE block_number >= ? AND status != 'REORGED'
        `
      )
      .run(args.rollbackFromBlock).changes;

    const affectedGroupIds = (
      db
        .prepare(
          `
            SELECT DISTINCT ag.id
            FROM aggregation_groups ag
            LEFT JOIN aggregation_group_source_fills agsf ON agsf.aggregation_group_id = ag.id
            LEFT JOIN source_fills sf ON sf.id = agsf.source_fill_id
            WHERE ag.status != 'REORGED'
              AND (
                ag.window_start_block >= @rollbackFromBlock
                OR sf.block_number >= @rollbackFromBlock
                OR sf.status = 'REORGED'
              )
          `
        )
        .all({ rollbackFromBlock: args.rollbackFromBlock }) as Array<{ id: string }>
    ).map((row) => row.id);

    if (affectedGroupIds.length > 0) {
      const placeholders = affectedGroupIds.map(() => "?").join(", ");
      const affectedDecisions = db
        .prepare(
          `
            SELECT
              cd.id AS decision_id,
              os.id AS order_id,
              os.current_state,
              os.intended_size_raw,
              COUNT(ff.id) AS fill_count
            FROM copy_decisions cd
            LEFT JOIN order_submissions os ON os.copy_decision_id = cd.id
            LEFT JOIN follower_fills ff ON ff.order_submission_id = os.id
            WHERE cd.aggregation_group_id IN (${placeholders})
            GROUP BY cd.id, os.id
          `
        )
        .all(...affectedGroupIds) as AffectedDecisionRow[];

      for (const row of affectedDecisions) {
        const noOrder = row.order_id === null;
        const zeroExposureTerminal =
          row.fill_count === 0 &&
          (noOrder || row.current_state === "CREATED" || row.current_state === "ACK_REJECTED" || row.current_state === "CANCELLED" || row.current_state === "FAILED");

        if (zeroExposureTerminal) {
          if (row.current_state === "CREATED" && row.order_id) {
            const cancelled = db
              .prepare(
                `
                  UPDATE order_submissions
                  SET current_state = 'CANCELLED',
                      filled_size_raw = '0',
                      abandoned_size_raw = intended_size_raw,
                      encrypted_signed_payload_json = NULL,
                      payload_erased_at = datetime('now'),
                      updated_at = datetime('now')
                  WHERE id = ? AND current_state = 'CREATED'
                `
              )
              .run(row.order_id).changes;
            if (cancelled !== 1) throw new Error(`Failed to cancel CREATED order ${row.order_id} during reorg cascade`);
            appendOrderAttempt(db, {
              orderId: row.order_id,
              fromState: "CREATED",
              toState: "CANCELLED",
              action: "REORG_CREATED_CANCEL",
              errorCode: "REORG"
            });
            summary.cancelledCreatedOrders += 1;
          }
          const released = db
            .prepare(
              `
                UPDATE risk_reservations
                SET state = 'RELEASED', released_at = datetime('now')
                WHERE copy_decision_id = ? AND state = 'ACTIVE'
              `
            )
            .run(row.decision_id).changes;
          summary.releasedReservations += released;
          db.prepare(
            `
              UPDATE copy_decisions
              SET status = 'SKIPPED_REORG', skip_reason = 'REORG', updated_at = datetime('now')
              WHERE id = ?
            `
          ).run(row.decision_id);
          summary.skippedReorgDecisions += 1;
          continue;
        }

        if (row.current_state === "SUBMITTING" && row.order_id) {
          const moved = db
            .prepare(
              `
                UPDATE order_submissions
                SET current_state = 'TIMEOUT_UNKNOWN',
                    last_error = 'REORG_ORPHAN_SUBMITTING',
                    updated_at = datetime('now')
                WHERE id = ? AND current_state = 'SUBMITTING'
              `
            )
            .run(row.order_id).changes;
          if (moved !== 1) throw new Error(`Failed to move SUBMITTING order ${row.order_id} to TIMEOUT_UNKNOWN`);
          appendOrderAttempt(db, {
            orderId: row.order_id,
            fromState: "SUBMITTING",
            toState: "TIMEOUT_UNKNOWN",
            action: "REORG_SUBMITTING_UNKNOWN",
            errorCode: "REORG"
          });
          summary.submitUnknownOrders += 1;
        }

        db.prepare(
          `
            UPDATE copy_decisions
            SET status = 'POST_REORG_ORPHAN', skip_reason = NULL, updated_at = datetime('now')
            WHERE id = ?
          `
        ).run(row.decision_id);
        summary.postReorgOrphans += 1;
      }

      summary.reorgedAggregationGroups = db
        .prepare(`UPDATE aggregation_groups SET status = 'REORGED', updated_at = datetime('now') WHERE id IN (${placeholders})`)
        .run(...affectedGroupIds).changes;
    }

    if (summary.postReorgOrphans > 0) {
      db.prepare(
        "INSERT OR REPLACE INTO runtime_state (key, value, updated_at) VALUES ('live_halt_reorg_orphan', '1', datetime('now'))"
      ).run();
      summary.liveHalted = true;
    }
    db.prepare(
      "INSERT OR REPLACE INTO runtime_state (key, value, updated_at) VALUES ('ingestion_halt_reorg', '1', datetime('now'))"
    ).run();

    const cursorAfter = Math.max(0, args.rollbackFromBlock - 1);
    db.prepare(
      "INSERT OR REPLACE INTO runtime_state (key, value, updated_at) VALUES ('last_processed_block', ?, datetime('now'))"
    ).run(cursorAfter.toString());
    db.prepare(
      `
        INSERT INTO block_cursor_history (
          id, chain_id, action, from_block, to_block, safe_head_at_process, cursor_before, cursor_after
        ) VALUES (?, 137, 'ROLLBACK', ?, ?, ?, ?, ?)
      `
    ).run(
      stableId("bch", `ROLLBACK|${args.rollbackFromBlock}|${args.safeHead}|${args.cursorBefore}|${cursorAfter}|${Date.now()}`),
      args.rollbackFromBlock,
      args.safeHead,
      args.safeHead,
      args.cursorBefore,
      cursorAfter
    );

    return summary;
  });

  return transaction();
}

export async function detectReorgedBlockNumbers(
  db: SqliteDatabase,
  rpc: RpcAdapter,
  args: { fromBlock: bigint; toBlock: bigint }
): Promise<number[]> {
  const rows = db
    .prepare(
      `
        SELECT block_number, block_hash
        FROM processed_blocks
        WHERE chain_id = 137 AND status = 'ACTIVE' AND block_number >= ? AND block_number <= ?
      `
    )
    .all(Number(args.fromBlock), Number(args.toBlock)) as Array<{ block_number: number; block_hash: Hex }>;

  const reorged: number[] = [];
  for (const row of rows) {
    const block = await rpc.getBlock(BigInt(row.block_number));
    if (block.hash.toLowerCase() !== row.block_hash.toLowerCase()) {
      reorged.push(row.block_number);
    }
  }
  return reorged;
}

function parseRawLog(rawLogJson: string): RawOrderFilledLog {
  const parsed = JSON.parse(rawLogJson) as RawOrderFilledLog;
  return {
    ...parsed,
    blockNumber: BigInt(parsed.blockNumber)
  };
}

export async function promotePendingFills(
  db: SqliteDatabase,
  rpc: RpcAdapter,
  args: { sourceWallets: Hex[]; safeHead: bigint; exchangeAddresses?: Hex[] }
): Promise<PromotedFill[]> {
  const exchangeAddresses = args.exchangeAddresses ?? [CTF_EXCHANGE_V2, NEG_RISK_CTF_EXCHANGE_V2];
  const rows = db
    .prepare(
      `
        SELECT id, raw_log_json
        FROM source_fills
        WHERE status = 'PENDING' AND block_number <= ?
        ORDER BY block_number ASC, log_index ASC
      `
    )
    .all(Number(args.safeHead)) as Array<{ id: string; raw_log_json: string }>;

  const promoted: PromotedFill[] = [];
  for (const row of rows) {
    const raw = parseRawLog(row.raw_log_json);
    const decoded = decodeOrderFilledLog(raw);
    const block = await rpc.getBlock(decoded.blockNumber);
    if (block.hash.toLowerCase() !== decoded.blockHash.toLowerCase()) {
      db.prepare("UPDATE source_fills SET status = 'REORGED', updated_at = datetime('now') WHERE id = ?").run(row.id);
      continue;
    }
    ensureProcessedBlock(db, {
      blockNumber: decoded.blockNumber,
      blockHash: block.hash,
      timestampMs: block.timestampMs,
      logCount: 1
    });
    const normalized = normalizeSourceFill(decoded, {
      sourceWallets: args.sourceWallets,
      exchangeAddresses
    });
    db.prepare(
      `
        UPDATE source_fills
        SET status = @status,
            skip_reason = @skipReason,
            block_hash = @blockHash,
            decoded_json = @decodedJson,
            source_wallet = @sourceWallet,
            side = @side,
            fee_raw = @feeRaw,
            price_ppm = @pricePpm,
            error_reason = @errorReason,
            updated_at = datetime('now')
        WHERE id = @id
      `
    ).run({
      id: row.id,
      status: normalized.accepted ? "NORMALIZED" : "SKIPPED",
      skipReason: normalized.accepted ? null : normalized.skipReason,
      blockHash: block.hash,
      decodedJson: jsonStringify(normalized.accepted ? { ...normalized, blockHash: block.hash } : decoded),
      sourceWallet: normalized.accepted ? normalized.sourceWallet : normalized.sourceWallet ?? null,
      side: normalized.accepted ? normalized.side : decoded.side,
      feeRaw: normalized.accepted ? normalized.feeRaw : decoded.feeRaw,
      pricePpm: decoded.pricePpm,
      errorReason: normalized.accepted ? null : normalized.errorReason ?? null
    });
    if (normalized.accepted) {
      promoted.push({ ...normalized, id: row.id, blockHash: block.hash });
    }
  }
  return promoted;
}

export function ingestRawLog(
  db: SqliteDatabase,
  raw: RawOrderFilledLog,
  blockTimestampMs: number
): { id: string; inserted: boolean; decoded: DecodedOrderFilled } {
  const decoded = decodeOrderFilledLog(raw);
  ensureProcessedBlock(db, {
    blockNumber: decoded.blockNumber,
    blockHash: decoded.blockHash,
    timestampMs: blockTimestampMs,
    logCount: 1
  });
  const { id, inserted } = insertPendingSourceFill(db, decoded, raw);
  return { id, inserted, decoded };
}
