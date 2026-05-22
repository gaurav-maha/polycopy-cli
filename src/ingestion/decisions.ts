import type { SqliteDatabase } from "../db/client.js";
import type { AggregationGroup } from "../normalize/aggregate.js";
import { evaluateDryRunDecision } from "../risk/gates.js";
import { stableId } from "./pending-fills.js";

export async function insertCopyDecision(
  db: SqliteDatabase,
  group: AggregationGroup,
  decision: Awaited<ReturnType<typeof evaluateDryRunDecision>>
): Promise<void> {
  const aggregationGroupId = group.id;
  db.prepare(
    `
      INSERT OR IGNORE INTO aggregation_groups (
        id, chain_id, contract_address, source_wallet, token_id, side,
        window_start_block, window_end_block, reorg_generation, status,
        leader_price_ppm, leader_notional_raw, leader_budget_impact_raw, token_delta_raw, inventory_delta_raw, fee_raw
      ) VALUES (
        @id, 137, @contractAddress, @sourceWallet, @tokenId, @side,
        @windowStartBlock, @windowEndBlock, @reorgGeneration, 'DECIDED',
        @leaderPricePpm, @leaderNotionalRaw, @leaderBudgetImpactRaw, @tokenDeltaRaw, @inventoryDeltaRaw, @feeRaw
      )
    `
  ).run({
    id: aggregationGroupId,
    contractAddress: group.contractAddress,
    sourceWallet: group.sourceWallet,
    tokenId: group.tokenId,
    side: group.side,
    windowStartBlock: group.windowStartBlock,
    windowEndBlock: group.windowEndBlock,
    reorgGeneration: group.reorgGeneration,
    leaderPricePpm: group.leaderPricePpm,
    leaderNotionalRaw: group.leaderNotionalRaw,
    leaderBudgetImpactRaw: group.leaderBudgetImpactRaw,
    tokenDeltaRaw: group.tokenDeltaRaw,
    inventoryDeltaRaw: group.inventoryDeltaRaw,
    feeRaw: group.feeRaw
  });
  for (const sourceFillId of group.sourceFillIds) {
    db.prepare("INSERT OR IGNORE INTO aggregation_group_source_fills (aggregation_group_id, source_fill_id) VALUES (?, ?)").run(
      aggregationGroupId,
      sourceFillId
    );
    db.prepare("UPDATE source_fills SET status = 'DECIDED', updated_at = datetime('now') WHERE id = ?").run(sourceFillId);
  }
  db.prepare(
    `
      INSERT OR IGNORE INTO copy_decisions (
        id, aggregation_group_id, chain_id, contract_address, source_wallet, token_id, side,
        status, leader_price_ppm, leader_notional_raw, leader_budget_impact_raw,
        intended_copy_notional_raw, approved_copy_notional_raw, risk_config_hash,
        gate_snapshot_json, skip_reason
      ) VALUES (
        @id, @aggregationGroupId, 137, @contractAddress, @sourceWallet, @tokenId, @side,
        @status, @leaderPricePpm, @leaderNotionalRaw, @leaderBudgetImpactRaw,
        @intendedCopyNotionalRaw, @approvedCopyNotionalRaw, @riskConfigHash,
        @gateSnapshotJson, @skipReason
      )
    `
  ).run({
    id: stableId("cd", aggregationGroupId),
    aggregationGroupId,
    contractAddress: group.contractAddress,
    sourceWallet: group.sourceWallet,
    tokenId: group.tokenId,
    side: group.side,
    status: decision.status,
    leaderPricePpm: group.leaderPricePpm,
    leaderNotionalRaw: group.leaderNotionalRaw,
    leaderBudgetImpactRaw: group.leaderBudgetImpactRaw,
    intendedCopyNotionalRaw: decision.intendedCopyNotionalRaw,
    approvedCopyNotionalRaw: decision.approvedCopyNotionalRaw,
    riskConfigHash: stableId("risk", JSON.stringify(decision.gateSnapshot)),
    gateSnapshotJson: JSON.stringify(decision.gateSnapshot),
    skipReason: decision.skipReason
  });
}
