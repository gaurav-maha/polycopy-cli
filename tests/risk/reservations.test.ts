import { afterEach, describe, expect, it } from "vitest";
import type { TempDb } from "../helpers/temp-db.js";
import { createMigratedTempDb } from "../helpers/temp-db.js";
import {
  globalDailyRemainingRaw,
  globalFreeBudgetRemainingRaw,
  loadDecisionBatchState
} from "../../src/risk/leader-budgets.js";
import { loadActiveSellInventoryReservationsRaw } from "../../src/risk/reservations.js";
import { stableId } from "../../src/ingestion/pending-fills.js";

const leader = "0x9d84ce0306f8551e02efef1680475fc0f1dc1344" as const;

function insertActiveReservation(
  db: TempDb["db"],
  args: {
    id: string;
    tokenId?: string;
    side?: "BUY" | "SELL";
    pUsdReservedRaw?: string;
    pUsdFeeReservedRaw?: string;
    inventoryReservedRaw?: string;
  }
): void {
  const groupId = stableId("ag", args.id);
  const decisionId = stableId("cd", args.id);
  db.prepare(
    `
      INSERT INTO aggregation_groups (
        id, chain_id, contract_address, source_wallet, token_id, side,
        window_start_block, window_end_block, reorg_generation, status,
        leader_price_ppm, leader_notional_raw, leader_budget_impact_raw, token_delta_raw, inventory_delta_raw, fee_raw
      ) VALUES (?, 137, '0xE111180000d2663C0091e4f400237545B87B996B', ?, ?, ?, 1, 3, 0, 'DECIDED', '1', '1', '1', '0', '0', '0')
    `
  ).run(groupId, leader, args.tokenId ?? "1", args.side ?? "BUY");
  db.prepare(
    `
      INSERT INTO copy_decisions (
        id, aggregation_group_id, chain_id, contract_address, source_wallet, token_id, side,
        status, leader_price_ppm, leader_notional_raw, leader_budget_impact_raw,
        intended_copy_notional_raw, approved_copy_notional_raw, risk_config_hash, gate_snapshot_json
      ) VALUES (?, ?, 137, '0xE111180000d2663C0091e4f400237545B87B996B', ?, ?, ?, 'ACTIVE', '1', '1', '1', '1', '1', 'risk', '{}')
    `
  ).run(decisionId, groupId, leader, args.tokenId ?? "1", args.side ?? "BUY");
  db.prepare(
    `
      INSERT INTO risk_reservations (
        id, copy_decision_id, token_id, side, p_usd_reserved_raw, p_usd_fee_reserved_raw, inventory_reserved_raw, state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE')
    `
  ).run(
    args.id,
    decisionId,
    args.tokenId ?? "1",
    args.side ?? "BUY",
    args.pUsdReservedRaw ?? "0",
    args.pUsdFeeReservedRaw ?? "0",
    args.inventoryReservedRaw ?? "0"
  );
}

describe("risk reservations", () => {
  let tempDb: TempDb | undefined;

  afterEach(async () => {
    await tempDb?.cleanup();
    tempDb = undefined;
  });

  it("subtracts active pUSD and fee reservations from global free and daily budgets", async () => {
    tempDb = await createMigratedTempDb();
    insertActiveReservation(tempDb.db, {
      id: "reservation-buy",
      pUsdReservedRaw: "100",
      pUsdFeeReservedRaw: "7"
    });

    const state = loadDecisionBatchState(tempDb.db, { nowMs: Date.UTC(2026, 4, 22), leaders: [leader] });

    expect(globalFreeBudgetRemainingRaw({ freeBudgetPusdRaw: "1000" }, state)).toBe(893n);
    expect(globalDailyRemainingRaw({ maxDailySpendPusdRaw: "1000", maxTradesPerDay: 5 }, state)).toBe(893n);
  });

  it("subtracts active SELL inventory reservations from reconciled inventory", async () => {
    tempDb = await createMigratedTempDb();
    insertActiveReservation(tempDb.db, {
      id: "reservation-sell",
      tokenId: "123",
      side: "SELL",
      inventoryReservedRaw: "40"
    });

    expect(loadActiveSellInventoryReservationsRaw(tempDb.db, "123")).toBe(40n);
  });
});
