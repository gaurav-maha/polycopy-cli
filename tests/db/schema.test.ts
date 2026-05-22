import type { TempDb } from "../helpers/temp-db.js";
import { createMigratedTempDb } from "../helpers/temp-db.js";
import { runMigrations } from "../../src/db/migrate.js";

describe("SQLite schema migrations", () => {
  let tempDb: TempDb | undefined;

  afterEach(async () => {
    await tempDb?.cleanup();
    tempDb = undefined;
  });

  it("applies the initial migration idempotently and records migration metadata", async () => {
    tempDb = await createMigratedTempDb();

    runMigrations(tempDb.db);

    const rows = tempDb.db
      .prepare("SELECT version, name FROM migrations ORDER BY version")
      .all() as Array<{ version: number; name: string }>;

    expect(rows).toEqual([
      { version: 1, name: "001_initial.sql" },
      { version: 2, name: "002_pending_source_fills.sql" },
      { version: 3, name: "003_leader_budgets.sql" },
      { version: 4, name: "004_price_bound_skip_reasons.sql" }
    ]);
  });

  it("creates the contract tables and indexes", async () => {
    tempDb = await createMigratedTempDb();

    const tables = tempDb.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .pluck()
      .all() as string[];
    const indexes = tempDb.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .pluck()
      .all() as string[];

    expect(tables).toEqual(
      expect.arrayContaining([
        "migrations",
        "runtime_state",
        "processed_blocks",
        "block_cursor_history",
        "source_fills",
        "aggregation_groups",
        "aggregation_group_source_fills",
        "copy_decisions",
        "risk_reservations",
        "order_submissions",
        "order_attempts",
        "follower_fills",
        "position_movements",
        "positions",
        "reconciliation_runs",
        "leader_budgets"
      ])
    );
    expect(indexes).toEqual(
      expect.arrayContaining([
        "ux_processed_blocks_active",
        "ix_processed_blocks_status_number",
        "ix_source_fills_status_block",
        "ix_source_fills_tx",
        "ux_aggregation_groups_active_window",
        "ix_aggregation_groups_status_window",
        "ix_copy_decisions_source_created",
        "ix_copy_decisions_status",
        "ux_risk_reservations_active",
        "ix_order_submissions_state_updated",
        "ix_order_attempts_submission_created",
        "ux_position_movements_fill",
        "ix_position_movements_token_occurred"
      ])
    );
  });

  it("opens every test database with required SQLite pragmas", async () => {
    tempDb = await createMigratedTempDb();

    expect(tempDb.db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(tempDb.db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(tempDb.db.pragma("synchronous", { simple: true })).toBe(2);
    expect(tempDb.db.pragma("busy_timeout", { simple: true })).toBe(5000);
  });

  it("stores raw bigint and token amounts as TEXT columns", async () => {
    tempDb = await createMigratedTempDb();

    const textColumns = new Map<string, string>();
    for (const table of [
      "source_fills",
      "aggregation_groups",
      "copy_decisions",
      "risk_reservations",
      "order_submissions",
      "follower_fills",
      "position_movements",
      "positions",
      "reconciliation_runs"
    ]) {
      const columns = tempDb.db.pragma(`table_info(${table})`) as Array<{ name: string; type: string }>;
      for (const column of columns) {
        if (
          column.name.endsWith("_raw") ||
          column.name.endsWith("_ppm") ||
          column.name === "token_id" ||
          column.name === "p_usd_balance_raw"
        ) {
          textColumns.set(`${table}.${column.name}`, column.type);
        }
      }
    }

    expect(Object.fromEntries(textColumns)).toMatchObject({
      "source_fills.token_id": "TEXT",
      "source_fills.maker_amount_filled_raw": "TEXT",
      "source_fills.taker_amount_filled_raw": "TEXT",
      "source_fills.fee_raw": "TEXT",
      "source_fills.price_ppm": "TEXT",
      "aggregation_groups.token_id": "TEXT",
      "aggregation_groups.leader_price_ppm": "TEXT",
      "aggregation_groups.leader_notional_raw": "TEXT",
      "aggregation_groups.leader_budget_impact_raw": "TEXT",
      "aggregation_groups.token_delta_raw": "TEXT",
      "aggregation_groups.inventory_delta_raw": "TEXT",
      "aggregation_groups.fee_raw": "TEXT",
      "copy_decisions.token_id": "TEXT",
      "copy_decisions.leader_price_ppm": "TEXT",
      "copy_decisions.leader_notional_raw": "TEXT",
      "copy_decisions.leader_budget_impact_raw": "TEXT",
      "copy_decisions.intended_copy_notional_raw": "TEXT",
      "copy_decisions.approved_copy_notional_raw": "TEXT",
      "risk_reservations.token_id": "TEXT",
      "risk_reservations.p_usd_reserved_raw": "TEXT",
      "risk_reservations.p_usd_fee_reserved_raw": "TEXT",
      "risk_reservations.inventory_reserved_raw": "TEXT",
      "order_submissions.limit_price_ppm": "TEXT",
      "order_submissions.intended_notional_raw": "TEXT",
      "order_submissions.intended_size_raw": "TEXT",
      "order_submissions.filled_size_raw": "TEXT",
      "order_submissions.abandoned_size_raw": "TEXT",
      "follower_fills.token_id": "TEXT",
      "follower_fills.price_ppm": "TEXT",
      "follower_fills.size_raw": "TEXT",
      "follower_fills.p_usd_delta_raw": "TEXT",
      "follower_fills.fee_raw": "TEXT",
      "position_movements.token_id": "TEXT",
      "position_movements.shares_delta_raw": "TEXT",
      "position_movements.p_usd_delta_raw": "TEXT",
      "positions.shares_raw": "TEXT",
      "positions.expected_onchain_shares_raw": "TEXT",
      "positions.last_onchain_shares_raw": "TEXT",
      "reconciliation_runs.p_usd_balance_raw": "TEXT"
    });
  });

  it("deduplicates source fills by canonical source log identity", async () => {
    tempDb = await createMigratedTempDb();

    const insertSourceFill = tempDb.db.prepare(`
      INSERT INTO source_fills (
        id,
        chain_id,
        contract_address,
        block_number,
        block_hash,
        tx_hash,
        tx_index,
        log_index,
        status,
        raw_log_json
      )
      VALUES (
        @id,
        137,
        '0xexchange',
        123,
        '0xblock',
        '0xtx',
        4,
        9,
        'INGESTED',
        '{"topics":[]}'
      )
    `);

    insertSourceFill.run({ id: "source-fill-1" });

    expect(() => insertSourceFill.run({ id: "source-fill-2" })).toThrow(/UNIQUE constraint failed/);
  });

  it("rejects illegal order submission states", async () => {
    tempDb = await createMigratedTempDb();
    insertDecisionGraph(tempDb);

    const insertOrderSubmission = tempDb.db.prepare(`
      INSERT INTO order_submissions (
        id,
        copy_decision_id,
        signed_order_hash,
        encrypted_signed_payload_json,
        current_state,
        order_type,
        limit_price_ppm,
        intended_notional_raw,
        intended_size_raw
      )
      VALUES (
        'order-1',
        'decision-1',
        '0xsigned',
        '{"ciphertext":"abc"}',
        'ACKED',
        'FAK',
        '500000',
        '1000000',
        '2000000'
      )
    `);

    expect(() => insertOrderSubmission.run()).toThrow(/CHECK constraint failed/);
  });

  it("accepts explicit price-bound skip reasons", async () => {
    tempDb = await createMigratedTempDb();
    insertDecisionGraph(tempDb);

    tempDb.db
      .prepare("UPDATE copy_decisions SET status = 'SKIPPED', skip_reason = 'PRICE_ABOVE_MAX_BUY' WHERE id = 'decision-1'")
      .run();

    expect(tempDb.db.prepare("SELECT status, skip_reason FROM copy_decisions WHERE id = 'decision-1'").get()).toEqual({
      status: "SKIPPED",
      skip_reason: "PRICE_ABOVE_MAX_BUY"
    });
  });
});

function insertDecisionGraph(tempDb: TempDb): void {
  tempDb.db
    .prepare(
      `
      INSERT INTO aggregation_groups (
        id,
        chain_id,
        contract_address,
        source_wallet,
        token_id,
        side,
        window_start_block,
        window_end_block,
        status
      )
      VALUES (
        'group-1',
        137,
        '0xexchange',
        '0xsource',
        '123456789',
        'BUY',
        100,
        101,
        'DECIDED'
      )
    `
    )
    .run();

  tempDb.db
    .prepare(
      `
      INSERT INTO copy_decisions (
        id,
        aggregation_group_id,
        chain_id,
        contract_address,
        source_wallet,
        token_id,
        side,
        status,
        leader_price_ppm,
        leader_notional_raw,
        leader_budget_impact_raw,
        intended_copy_notional_raw,
        risk_config_hash,
        gate_snapshot_json
      )
      VALUES (
        'decision-1',
        'group-1',
        137,
        '0xexchange',
        '0xsource',
        '123456789',
        'BUY',
        'ACTIVE',
        '500000',
        '1000000',
        '1000000',
        '250000',
        'risk-hash',
        '{}'
      )
    `
    )
    .run();
}
