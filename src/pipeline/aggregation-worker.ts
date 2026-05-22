import type { SqliteDatabase } from "../db/client.js";
import type { DecodedOrderFilled } from "../protocol/decode-order-filled.js";
import { aggregateFills, computeAggregationGroupId, type AggregationGroup, type FillWithId } from "../normalize/aggregate.js";
import { stableId } from "../ingestion/pending-fills.js";

export function upsertOpenAggregationGroup(
  db: SqliteDatabase,
  fill: FillWithId,
  args: { aggregationWindowBlocks: number; reorgGeneration: number }
): AggregationGroup {
  const existing = db
    .prepare(
      `
        SELECT id FROM aggregation_groups
        WHERE chain_id = 137
          AND contract_address = ?
          AND source_wallet = ?
          AND token_id = ?
          AND side = ?
          AND status = 'OPEN'
          AND window_start_block <= ?
          AND window_end_block >= ?
        ORDER BY window_start_block ASC
        LIMIT 1
      `
    )
    .get(
      fill.contractAddress,
      fill.sourceWallet ?? fill.maker,
      fill.tokenId,
      fill.side,
      Number(fill.blockNumber),
      Number(fill.blockNumber)
    ) as { id: string } | undefined;

  const linkedFills: FillWithId[] = [];
  if (existing) {
    const rows = db
      .prepare(
        `
          SELECT sf.id, sf.decoded_json
          FROM aggregation_group_source_fills agsf
          JOIN source_fills sf ON sf.id = agsf.source_fill_id
          WHERE agsf.aggregation_group_id = ?
        `
      )
      .all(existing.id) as Array<{ id: string; decoded_json: string }>;
    for (const row of rows) {
      linkedFills.push({ ...(JSON.parse(row.decoded_json) as DecodedOrderFilled), id: row.id });
    }
  }
  linkedFills.push(fill);
  const groups = aggregateFills(linkedFills, args);
  const computed = groups[0]!;
  const group: AggregationGroup = existing ? { ...computed, id: existing.id } : computed;

  db.prepare(
    `
      INSERT INTO aggregation_groups (
        id, chain_id, contract_address, source_wallet, token_id, side,
        window_start_block, window_end_block, reorg_generation, status,
        leader_price_ppm, leader_notional_raw, leader_budget_impact_raw, token_delta_raw, inventory_delta_raw, fee_raw
      ) VALUES (
        @id, 137, @contractAddress, @sourceWallet, @tokenId, @side,
        @windowStartBlock, @windowEndBlock, @reorgGeneration, 'OPEN',
        @leaderPricePpm, @leaderNotionalRaw, @leaderBudgetImpactRaw, @tokenDeltaRaw, @inventoryDeltaRaw, @feeRaw
      )
      ON CONFLICT(id) DO UPDATE SET
        leader_price_ppm = excluded.leader_price_ppm,
        leader_notional_raw = excluded.leader_notional_raw,
        leader_budget_impact_raw = excluded.leader_budget_impact_raw,
        token_delta_raw = excluded.token_delta_raw,
        inventory_delta_raw = excluded.inventory_delta_raw,
        fee_raw = excluded.fee_raw,
        updated_at = datetime('now')
    `
  ).run({
    id: group.id,
    contractAddress: group.contractAddress,
    sourceWallet: group.sourceWallet,
    tokenId: group.tokenId,
    side: group.side,
    windowStartBlock: group.windowStartBlock,
    windowEndBlock: group.windowStartBlock + args.aggregationWindowBlocks,
    reorgGeneration: group.reorgGeneration,
    leaderPricePpm: group.leaderPricePpm,
    leaderNotionalRaw: group.leaderNotionalRaw,
    leaderBudgetImpactRaw: group.leaderBudgetImpactRaw,
    tokenDeltaRaw: group.tokenDeltaRaw,
    inventoryDeltaRaw: group.inventoryDeltaRaw,
    feeRaw: group.feeRaw
  });

  db.prepare("INSERT OR IGNORE INTO aggregation_group_source_fills (aggregation_group_id, source_fill_id) VALUES (?, ?)").run(
    group.id,
    fill.id
  );
  db.prepare("UPDATE source_fills SET status = 'GROUPED', updated_at = datetime('now') WHERE id = ?").run(fill.id);
  return { ...group, windowEndBlock: group.windowStartBlock + args.aggregationWindowBlocks, sourceFillIds: linkedFills.map((entry) => entry.id) };
}

export function closeReadyAggregationGroups(db: SqliteDatabase, lastProcessedBlock: number): AggregationGroup[] {
  const rows = db
    .prepare(
      `
        SELECT *
        FROM aggregation_groups
        WHERE status = 'OPEN' AND window_end_block <= ?
      `
    )
    .all(lastProcessedBlock) as Array<Record<string, unknown>>;

  const ready: AggregationGroup[] = [];
  for (const row of rows) {
    db.prepare("UPDATE aggregation_groups SET status = 'READY', updated_at = datetime('now') WHERE id = ?").run(row.id);
    const sourceFillIds = (
      db
        .prepare("SELECT source_fill_id FROM aggregation_group_source_fills WHERE aggregation_group_id = ?")
        .all(String(row.id)) as Array<{ source_fill_id: string }>
    ).map((entry) => entry.source_fill_id);
    ready.push({
      id: String(row.id),
      chainId: 137,
      contractAddress: String(row.contract_address) as AggregationGroup["contractAddress"],
      sourceWallet: String(row.source_wallet) as AggregationGroup["sourceWallet"],
      tokenId: String(row.token_id),
      side: String(row.side) as AggregationGroup["side"],
      windowStartBlock: Number(row.window_start_block),
      windowEndBlock: Number(row.window_end_block),
      reorgGeneration: Number(row.reorg_generation),
      sourceFillIds,
      leaderPricePpm: String(row.leader_price_ppm),
      leaderNotionalRaw: String(row.leader_notional_raw),
      leaderBudgetImpactRaw: String(row.leader_budget_impact_raw),
      tokenDeltaRaw: String(row.token_delta_raw),
      inventoryDeltaRaw: String(row.inventory_delta_raw),
      feeRaw: String(row.fee_raw)
    });
  }
  return ready;
}

export function computeGroupIdForFirstFill(fill: FillWithId, args: { reorgGeneration: number }): string {
  return computeAggregationGroupId({
    chainId: fill.chainId,
    contractAddress: fill.contractAddress,
    sourceWallet: fill.sourceWallet ?? fill.maker,
    tokenId: fill.tokenId,
    side: fill.side,
    windowStartBlock: Number(fill.blockNumber),
    reorgGeneration: args.reorgGeneration,
    firstSourceFillId: fill.id
  });
}
