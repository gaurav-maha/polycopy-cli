import { afterEach, describe, expect, it } from "vitest";
import type { SqliteDatabase } from "../../src/db/client.js";
import { loadSellInventory, sellInventoryForGates } from "../../src/risk/inventory.js";
import type { TempDb } from "../helpers/temp-db.js";
import { createMigratedTempDb } from "../helpers/temp-db.js";

const leader = "0x9d84ce0306f8551e02efef1680475fc0f1dc1344";
const contract = "0xE111180000d2663C0091e4f400237545B87B996B";

function insertPosition(
  db: SqliteDatabase,
  args: {
    tokenId: string;
    sharesRaw: string;
    lastReconciledAt: string | null;
  }
): void {
  db.prepare(
    `
      INSERT INTO positions (token_id, shares_raw, expected_onchain_shares_raw, last_onchain_shares_raw, last_reconciled_at)
      VALUES (?, ?, ?, ?, ?)
    `
  ).run(args.tokenId, args.sharesRaw, args.sharesRaw, args.sharesRaw, args.lastReconciledAt);
}

function insertReservation(
  db: SqliteDatabase,
  args: {
    id: string;
    tokenId: string;
    side: "BUY" | "SELL";
    inventoryReservedRaw: string;
    windowStartBlock: number;
    state?: "ACTIVE" | "RELEASED";
  }
): void {
  const groupId = `ag_${args.id}`;
  const decisionId = `cd_${args.id}`;
  db.prepare(
    `
      INSERT INTO aggregation_groups (
        id, chain_id, contract_address, source_wallet, token_id, side,
        window_start_block, window_end_block, reorg_generation, status,
        leader_price_ppm, leader_notional_raw, leader_budget_impact_raw, token_delta_raw, inventory_delta_raw, fee_raw
      ) VALUES (?, 137, ?, ?, ?, ?, ?, ?, 0, 'DECIDED', '1', '1', '1', '0', '0', '0')
    `
  ).run(groupId, contract, leader, args.tokenId, args.side, args.windowStartBlock, args.windowStartBlock + 2);
  db.prepare(
    `
      INSERT INTO copy_decisions (
        id, aggregation_group_id, chain_id, contract_address, source_wallet, token_id, side,
        status, leader_price_ppm, leader_notional_raw, leader_budget_impact_raw,
        intended_copy_notional_raw, approved_copy_notional_raw, risk_config_hash, gate_snapshot_json
      ) VALUES (?, ?, 137, ?, ?, ?, ?, 'ACTIVE', '1', '1', '1', '1', '1', 'risk', '{}')
    `
  ).run(decisionId, groupId, contract, leader, args.tokenId, args.side);
  db.prepare(
    `
      INSERT INTO risk_reservations (
        id, copy_decision_id, token_id, side, p_usd_reserved_raw, p_usd_fee_reserved_raw, inventory_reserved_raw, state
      ) VALUES (?, ?, ?, ?, '0', '0', ?, ?)
    `
  ).run(args.id, decisionId, args.tokenId, args.side, args.inventoryReservedRaw, args.state ?? "ACTIVE");
}

describe("SELL inventory loader", () => {
  let tempDb: TempDb | undefined;

  afterEach(async () => {
    await tempDb?.cleanup();
    tempDb = undefined;
  });

  it("returns NO_POSITION when the token has no position row", async () => {
    tempDb = await createMigratedTempDb();

    const result = loadSellInventory(tempDb.db, {
      tokenId: "123",
      nowMs: Date.UTC(2026, 4, 22, 12, 0, 0),
      maxPositionAgeMs: 300_000
    });

    expect(result).toEqual({ ok: false, reason: "NO_POSITION" });
  });

  it("returns STALE_POSITION when the position reconciliation is too old", async () => {
    tempDb = await createMigratedTempDb();
    insertPosition(tempDb.db, {
      tokenId: "123",
      sharesRaw: "100",
      lastReconciledAt: "2026-05-22T12:00:00.000Z"
    });

    const result = loadSellInventory(tempDb.db, {
      tokenId: "123",
      nowMs: Date.UTC(2026, 4, 22, 12, 5, 1),
      maxPositionAgeMs: 300_000
    });

    expect(result).toEqual({ ok: false, reason: "STALE_POSITION" });
  });

  it("loads fresh shares after subtracting active SELL reservations for the same token", async () => {
    tempDb = await createMigratedTempDb();
    insertPosition(tempDb.db, {
      tokenId: "123",
      sharesRaw: "100",
      lastReconciledAt: "2026-05-22T12:00:00.000Z"
    });
    insertReservation(tempDb.db, {
      id: "sell-same-token",
      tokenId: "123",
      side: "SELL",
      inventoryReservedRaw: "40",
      windowStartBlock: 1
    });
    insertReservation(tempDb.db, {
      id: "buy-same-token",
      tokenId: "123",
      side: "BUY",
      inventoryReservedRaw: "9",
      windowStartBlock: 2
    });
    insertReservation(tempDb.db, {
      id: "sell-other-token",
      tokenId: "456",
      side: "SELL",
      inventoryReservedRaw: "7",
      windowStartBlock: 3
    });
    insertReservation(tempDb.db, {
      id: "released-sell-same-token",
      tokenId: "123",
      side: "SELL",
      inventoryReservedRaw: "8",
      windowStartBlock: 4,
      state: "RELEASED"
    });

    const result = loadSellInventory(tempDb.db, {
      tokenId: "123",
      nowMs: Date.UTC(2026, 4, 22, 12, 4, 59),
      maxPositionAgeMs: 300_000
    });

    expect(result).toEqual({
      ok: true,
      inventory: {
        sharesRaw: "60",
        activeSellReservedSharesRaw: "40",
        lastReconciledAtMs: Date.UTC(2026, 4, 22, 12, 0, 0)
      }
    });
  });

  it("maps loaded inventory to gate inputs using reconciled shares", async () => {
    tempDb = await createMigratedTempDb();
    insertPosition(tempDb.db, {
      tokenId: "123",
      sharesRaw: "100",
      lastReconciledAt: "2026-05-22T12:00:00.000Z"
    });
    insertReservation(tempDb.db, {
      id: "sell-same-token",
      tokenId: "123",
      side: "SELL",
      inventoryReservedRaw: "40",
      windowStartBlock: 1
    });

    expect(
      sellInventoryForGates(tempDb.db, {
        tokenId: "123",
        nowMs: Date.UTC(2026, 4, 22, 12, 4, 59),
        maxPositionAgeMs: 300_000
      })
    ).toEqual({
      sharesRaw: "100",
      activeSellReservedSharesRaw: "40",
      lastReconciledAtMs: Date.UTC(2026, 4, 22, 12, 0, 0)
    });
  });
});
