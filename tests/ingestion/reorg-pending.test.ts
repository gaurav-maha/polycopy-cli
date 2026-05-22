import { encodeAbiParameters, encodeEventTopics } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { CTF_EXCHANGE_V2, ORDER_FILLED_EVENT_ABI } from "../../src/constants/abi.js";
import type { Hex, RpcAdapter } from "../../src/adapters/types.js";
import {
  cascadeReorg,
  detectReorgedBlockNumbers,
  ensureProcessedBlock,
  ingestRawLog,
  markReorgedBlocks,
  stableId
} from "../../src/ingestion/pending-fills.js";
import type { TempDb } from "../helpers/temp-db.js";
import { createMigratedTempDb } from "../helpers/temp-db.js";

const leader = "0x9d84ce0306f8551e02efef1680475fc0f1dc1344" as Hex;
const storedHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex;
const canonicalHash = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" as Hex;

function makeRawLog() {
  const topics = encodeEventTopics({
    abi: [ORDER_FILLED_EVENT_ABI],
    eventName: "OrderFilled",
    args: {
      orderHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
      maker: leader,
      taker: CTF_EXCHANGE_V2
    }
  }) as Hex[];
  const data = encodeAbiParameters(
    [
      { type: "uint8" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "bytes32" },
      { type: "bytes32" }
    ],
    [0, 1n, 1n, 1n, 0n, ("0x" + "0".repeat(64)) as Hex, ("0x" + "2".repeat(64)) as Hex]
  );
  return {
    chainId: 137 as const,
    address: CTF_EXCHANGE_V2,
    blockNumber: 100n,
    blockHash: storedHash,
    transactionHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Hex,
    transactionIndex: 0,
    logIndex: 0,
    topics,
    data
  };
}

describe("pending reorg handling", () => {
  let tempDb: TempDb | undefined;

  afterEach(async () => {
    await tempDb?.cleanup();
    tempDb = undefined;
  });

  it("marks pending fills reorged when stored block hash disagrees with RPC", async () => {
    tempDb = await createMigratedTempDb();
    ensureProcessedBlock(tempDb.db, {
      blockNumber: 100n,
      blockHash: storedHash,
      timestampMs: 1,
      logCount: 1
    });
    ingestRawLog(tempDb.db, makeRawLog(), 1);

    const rpc: RpcAdapter = {
      getChainId: async () => 137,
      getLatestBlock: async () => ({ number: 102n, hash: canonicalHash, timestampMs: 1 }),
      getBlock: async () => ({ number: 100n, hash: canonicalHash, timestampMs: 1 }),
      getCode: async () => "0x",
      getLogs: async () => [],
      getTransactionReceipt: async () => ({ blockHash: canonicalHash, logs: [] }),
      readContract: async () => {
        throw new Error("not used");
      }
    };

    const reorged = await detectReorgedBlockNumbers(tempDb.db, rpc, { fromBlock: 100n, toBlock: 100n });
    expect(reorged).toEqual([100]);
    const changed = markReorgedBlocks(tempDb.db, reorged);
    expect(changed).toBe(1);
    const row = tempDb.db.prepare("SELECT status FROM source_fills LIMIT 1").get() as { status: string };
    expect(row.status).toBe("REORGED");
    const block = tempDb.db.prepare("SELECT status FROM processed_blocks LIMIT 1").get() as { status: string };
    expect(block.status).toBe("REORGED");
  });

  it("uses deterministic processed block ids", () => {
    expect(stableId("pb", storedHash)).toMatch(/^pb_[a-f0-9]{64}$/);
  });

  it("marks no-exposure decisions as SKIPPED_REORG and cancels unsubmitted CREATED orders", async () => {
    tempDb = await createMigratedTempDb();
    const raw = makeRawLog();
    const { id: sourceFillId } = ingestRawLog(tempDb.db, raw, 1);
    const groupId = stableId("ag", "created-reorg");
    const decisionId = stableId("cd", groupId);
    const reservationId = stableId("rr", decisionId);
    const orderId = stableId("os", decisionId);

    tempDb.db
      .prepare(
        `
          INSERT INTO aggregation_groups (
            id, chain_id, contract_address, source_wallet, token_id, side,
            window_start_block, window_end_block, reorg_generation, status,
            leader_price_ppm, leader_notional_raw, leader_budget_impact_raw, token_delta_raw, inventory_delta_raw, fee_raw
          ) VALUES (?, 137, ?, ?, '1', 'BUY', 100, 102, 0, 'DECIDED', '1', '1', '1', '1', '0', '0')
        `
      )
      .run(groupId, CTF_EXCHANGE_V2, leader);
    tempDb.db.prepare("INSERT INTO aggregation_group_source_fills (aggregation_group_id, source_fill_id) VALUES (?, ?)").run(
      groupId,
      sourceFillId
    );
    tempDb.db
      .prepare(
        `
          INSERT INTO copy_decisions (
            id, aggregation_group_id, chain_id, contract_address, source_wallet, token_id, side,
            status, leader_price_ppm, leader_notional_raw, leader_budget_impact_raw,
            intended_copy_notional_raw, approved_copy_notional_raw, risk_config_hash, gate_snapshot_json
          ) VALUES (?, ?, 137, ?, ?, '1', 'BUY', 'ACTIVE', '1', '1', '1', '1', '1', 'risk', '{}')
        `
      )
      .run(decisionId, groupId, CTF_EXCHANGE_V2, leader);
    tempDb.db
      .prepare(
        `
          INSERT INTO risk_reservations (
            id, copy_decision_id, token_id, side, p_usd_reserved_raw, p_usd_fee_reserved_raw, inventory_reserved_raw, state
          ) VALUES (?, ?, '1', 'BUY', '1', '0', '0', 'ACTIVE')
        `
      )
      .run(reservationId, decisionId);
    tempDb.db
      .prepare(
        `
          INSERT INTO order_submissions (
            id, copy_decision_id, signed_order_hash, encrypted_signed_payload_json,
            current_state, order_type, limit_price_ppm, intended_notional_raw, intended_size_raw
          ) VALUES (?, ?, ?, '{"ciphertext":"x"}', 'CREATED', 'FAK', '1', '1', '7')
        `
      )
      .run(orderId, decisionId, `0x${"1".repeat(64)}`);

    const summary = cascadeReorg(tempDb.db, { rollbackFromBlock: 100, cursorBefore: 105, safeHead: 105 });

    expect(summary).toMatchObject({ skippedReorgDecisions: 1, postReorgOrphans: 0, cancelledCreatedOrders: 1 });
    expect(tempDb.db.prepare("SELECT status, skip_reason FROM copy_decisions WHERE id = ?").get(decisionId)).toEqual({
      status: "SKIPPED_REORG",
      skip_reason: "REORG"
    });
    expect(
      tempDb.db
        .prepare("SELECT current_state, encrypted_signed_payload_json, filled_size_raw, abandoned_size_raw FROM order_submissions WHERE id = ?")
        .get(orderId)
    ).toEqual({
      current_state: "CANCELLED",
      encrypted_signed_payload_json: null,
      filled_size_raw: "0",
      abandoned_size_raw: "7"
    });
    expect(tempDb.db.prepare("SELECT state FROM risk_reservations WHERE id = ?").get(reservationId)).toEqual({
      state: "RELEASED"
    });
  });

  it("marks submitted or uncertain decisions as POST_REORG_ORPHAN and halts live", async () => {
    tempDb = await createMigratedTempDb();
    const raw = makeRawLog();
    const { id: sourceFillId } = ingestRawLog(tempDb.db, raw, 1);
    const groupId = stableId("ag", "submitted-reorg");
    const decisionId = stableId("cd", groupId);

    tempDb.db
      .prepare(
        `
          INSERT INTO aggregation_groups (
            id, chain_id, contract_address, source_wallet, token_id, side,
            window_start_block, window_end_block, reorg_generation, status,
            leader_price_ppm, leader_notional_raw, leader_budget_impact_raw, token_delta_raw, inventory_delta_raw, fee_raw
          ) VALUES (?, 137, ?, ?, '1', 'BUY', 100, 102, 0, 'DECIDED', '1', '1', '1', '1', '0', '0')
        `
      )
      .run(groupId, CTF_EXCHANGE_V2, leader);
    tempDb.db.prepare("INSERT INTO aggregation_group_source_fills (aggregation_group_id, source_fill_id) VALUES (?, ?)").run(
      groupId,
      sourceFillId
    );
    tempDb.db
      .prepare(
        `
          INSERT INTO copy_decisions (
            id, aggregation_group_id, chain_id, contract_address, source_wallet, token_id, side,
            status, leader_price_ppm, leader_notional_raw, leader_budget_impact_raw,
            intended_copy_notional_raw, approved_copy_notional_raw, risk_config_hash, gate_snapshot_json
          ) VALUES (?, ?, 137, ?, ?, '1', 'BUY', 'ACTIVE', '1', '1', '1', '1', '1', 'risk', '{}')
        `
      )
      .run(decisionId, groupId, CTF_EXCHANGE_V2, leader);
    tempDb.db
      .prepare(
        `
          INSERT INTO order_submissions (
            id, copy_decision_id, signed_order_hash, encrypted_signed_payload_json,
            current_state, order_type, limit_price_ppm, intended_notional_raw, intended_size_raw
          ) VALUES (?, ?, ?, '{"ciphertext":"x"}', 'SUBMITTED', 'FAK', '1', '1', '7')
        `
      )
      .run(stableId("os", decisionId), decisionId, `0x${"2".repeat(64)}`);

    const summary = cascadeReorg(tempDb.db, { rollbackFromBlock: 100, cursorBefore: 105, safeHead: 105 });

    expect(summary).toMatchObject({ skippedReorgDecisions: 0, postReorgOrphans: 1, liveHalted: true });
    expect(tempDb.db.prepare("SELECT status FROM copy_decisions WHERE id = ?").get(decisionId)).toEqual({
      status: "POST_REORG_ORPHAN"
    });
    expect(tempDb.db.prepare("SELECT value FROM runtime_state WHERE key = 'live_halt_reorg_orphan'").get()).toEqual({
      value: "1"
    });
  });
});
