import type { SqliteDatabase } from "../../src/db/client.js";

export type ExecutionGraphIds = {
  groupId: string;
  decisionId: string;
  orderId?: string;
  reservationId?: string;
};

let sequence = 0;

export function nextExecutionId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

export function insertCopyDecision(
  db: SqliteDatabase,
  args: {
    groupId: string;
    decisionId: string;
    sourceWallet?: string;
    tokenId?: string;
    side?: "BUY" | "SELL";
    status?: "ACTIVE" | "SKIPPED" | "SKIPPED_REORG" | "POST_REORG_ORPHAN" | "ERROR";
  }
): void {
  const sourceWallet = args.sourceWallet ?? `0xsource${args.decisionId}`;
  const tokenId = args.tokenId ?? "123456789";
  const side = args.side ?? "BUY";

  db.prepare(
    `
      INSERT INTO aggregation_groups (
        id, chain_id, contract_address, source_wallet, token_id, side,
        window_start_block, window_end_block, status
      )
      VALUES (?, 137, '0xexchange', ?, ?, ?, 100, 101, 'DECIDED')
    `
  ).run(args.groupId, sourceWallet, tokenId, side);

  db.prepare(
    `
      INSERT INTO copy_decisions (
        id, aggregation_group_id, chain_id, contract_address, source_wallet, token_id, side,
        status, leader_price_ppm, leader_notional_raw, leader_budget_impact_raw,
        intended_copy_notional_raw, approved_copy_notional_raw, risk_config_hash, gate_snapshot_json
      )
      VALUES (?, ?, 137, '0xexchange', ?, ?, ?, ?, '500000', '1000000', '1000000', '250000', '250000', 'risk-hash', '{}')
    `
  ).run(args.decisionId, args.groupId, sourceWallet, tokenId, side, args.status ?? "ACTIVE");
}

export function insertExecutionGraph(
  db: SqliteDatabase,
  args: {
    groupId: string;
    decisionId: string;
    orderId?: string;
    reservationId?: string;
    currentState?: string;
    createdAt?: string;
    intendedSizeRaw?: string;
    encryptedPayload?: string | null;
  }
): ExecutionGraphIds {
  insertCopyDecision(db, args);

  if (args.reservationId) {
    db.prepare(
      `
        INSERT INTO risk_reservations (
          id, copy_decision_id, token_id, side,
          p_usd_reserved_raw, p_usd_fee_reserved_raw, inventory_reserved_raw, state
        )
        VALUES (?, ?, '123456789', 'BUY', '250000', '0', '0', 'ACTIVE')
      `
    ).run(args.reservationId, args.decisionId);
  }

  if (args.orderId) {
    db.prepare(
      `
        INSERT INTO order_submissions (
          id, copy_decision_id, signed_order_hash, encrypted_signed_payload_json,
          current_state, order_type, limit_price_ppm, intended_notional_raw, intended_size_raw,
          created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, 'FAK', '500000', '250000', ?, ?, ?)
      `
    ).run(
      args.orderId,
      args.decisionId,
      signedHashFor(args.orderId),
      args.encryptedPayload === undefined ? '{"ciphertext":"payload"}' : args.encryptedPayload,
      args.currentState ?? "CREATED",
      args.intendedSizeRaw ?? "7000",
      args.createdAt ?? "2026-05-22T10:00:00.000Z",
      args.createdAt ?? "2026-05-22T10:00:00.000Z"
    );
  }

  return {
    groupId: args.groupId,
    decisionId: args.decisionId,
    orderId: args.orderId,
    reservationId: args.reservationId
  };
}

function signedHashFor(value: string): string {
  return `0x${Buffer.from(value).toString("hex").padEnd(64, "0").slice(0, 64)}`;
}
