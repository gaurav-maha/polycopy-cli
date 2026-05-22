import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeAbiParameters, encodeEventTopics } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { CTF_EXCHANGE_V2, ORDER_FILLED_EVENT_ABI } from "../../src/constants/abi.js";
import type { BlockHeadAdapter, ChainLog, Hex, LogSubscriptionAdapter, RpcAdapter } from "../../src/adapters/types.js";
import { runIngestionLoop } from "../../src/ingestion/runner.js";
import { chainLogFromViem } from "../../src/ingestion/log-utils.js";
import { openDatabase } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { stableId } from "../../src/ingestion/pending-fills.js";

const leader = "0x9d84ce0306f8551e02efef1680475fc0f1dc1344" as Hex;
const secondLeader = "0x1111111111111111111111111111111111111111" as Hex;
const blockHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex;

function makeChainLog(
  blockNumber: bigint,
  args: { maker?: Hex; taker?: Hex; side?: 0 | 1; txHash?: Hex; logIndex?: number } = {}
): ChainLog {
  const topics = encodeEventTopics({
    abi: [ORDER_FILLED_EVENT_ABI],
    eventName: "OrderFilled",
    args: {
      orderHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
      maker: args.maker ?? leader,
      taker: args.taker ?? CTF_EXCHANGE_V2
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
    [
      args.side ?? 0,
      99n,
      400000n,
      1000000n,
      0n,
      ("0x" + "0".repeat(64)) as Hex,
      ("0x" + "2".repeat(64)) as Hex
    ]
  );
  return chainLogFromViem({
    address: CTF_EXCHANGE_V2,
    blockHash,
    blockNumber,
    transactionHash: args.txHash ?? "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    transactionIndex: 0,
    logIndex: args.logIndex ?? 0,
    topics: topics as [Hex, ...Hex[]],
    data,
    removed: false
  });
}

describe("ingestion runner", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("detects at mine and commits after confirmation depth via websocket adapters", async () => {
    dir = await mkdtemp(join(tmpdir(), "polycopy-runner-"));
    const dbPath = join(dir, "runner.db");
    const logPath = join(dir, "runner.jsonl");
    const fill = makeChainLog(100n);

    const rpc: RpcAdapter = {
      getChainId: async () => 137,
      getLatestBlock: async () => ({ number: 104n, hash: blockHash, timestampMs: 1_700_000_000_000 }),
      getBlock: async (number) => ({ number, hash: blockHash, timestampMs: 1_700_000_000_000 }),
      getCode: async () => "0x",
      getLogs: async () => [],
      getTransactionReceipt: async () => ({ blockHash, logs: [] }),
      readContract: async () => {
        throw new Error("not used");
      }
    };

    const logs: LogSubscriptionAdapter = {
      subscribeOrderFilled: async ({ onLog }) => {
        await onLog(fill);
        return () => undefined;
      }
    };
    const blockHead: BlockHeadAdapter = {
      watchBlockHead: async (onHead) => {
        await onHead({ number: 102n, hash: blockHash, timestampMs: 1_700_000_000_000 });
        await onHead({ number: 104n, hash: blockHash, timestampMs: 1_700_000_000_000 });
        return () => undefined;
      }
    };

    const summary = await runIngestionLoop({
      rpcUrl: "http://localhost:0",
      leaders: [leader],
      dbPath,
      logPath,
      durationMs: 50,
      lookbackBlocks: 10n,
      confirmationDepth: 2,
      aggregationWindowBlocks: 2,
      reorgLookbackBlocks: 64,
      confirmedLogMaxDelayMs: 120_000,
      polygonBlockTimeMs: 2_000,
      risk: {
        copyPct: "0.10",
        maxTradePusdRaw: "1000000",
        maxDailySpendPusdRaw: "5000000",
        maxMarketPositionPusdRaw: "5000000",
        freeBudgetPusdRaw: "5000000",
        maxTradesPerDay: 5,
        maxTradeFractionOfBudgetBps: 5000,
        maxBuyPpm: 980_000,
        minSellPpm: 20_000,
        maxSpreadPpm: 80_000,
        maxDriftPpm: 30_000,
        maxBookParticipationBps: 1500,
        slippageCapPpm: 50_000
      },
      enableSell: false,
      subscriptions: { logs, blockHead },
      rpc
    });

    expect(summary.transport).toBe("websocket");
    expect(summary.errors).toBe(0);
    expect(summary.logsSeen).toBeGreaterThanOrEqual(1);
    expect(summary.decisions).toBeGreaterThanOrEqual(1);

    const jsonl = await readFile(logPath, "utf8");
    expect(jsonl).toContain("source_fill_pending");

    const db = openDatabase(dbPath);
    const fillCount = db.prepare("SELECT COUNT(*) AS count FROM source_fills").get() as { count: number };
    const decided = db.prepare("SELECT COUNT(*) AS count FROM source_fills WHERE status = 'DECIDED'").get() as {
      count: number;
    };
    const decisions = db.prepare("SELECT COUNT(*) AS count FROM copy_decisions").get() as { count: number };
    db.close();

    expect(fillCount.count).toBeGreaterThanOrEqual(1);
    expect(decided.count).toBeGreaterThanOrEqual(1);
    expect(decisions.count).toBeGreaterThanOrEqual(1);
  });

  it("derives websocket url from http rpc url", async () => {
    const { deriveWsUrl } = await import("../../src/ingestion/rpc-url.js");
    expect(deriveWsUrl("https://polygon-mainnet.g.alchemy.com/v2/key")).toBe(
      "wss://polygon-mainnet.g.alchemy.com/v2/key"
    );
  });

  it("uses injected live metadata and book resolvers for ready decisions", async () => {
    dir = await mkdtemp(join(tmpdir(), "polycopy-runner-live-market-"));
    const dbPath = join(dir, "runner.db");
    const logPath = join(dir, "runner.jsonl");
    const fill = makeChainLog(100n);
    const nowMs = Date.now();

    const rpc: RpcAdapter = {
      getChainId: async () => 137,
      getLatestBlock: async () => ({ number: 104n, hash: blockHash, timestampMs: nowMs }),
      getBlock: async (number) => ({ number, hash: blockHash, timestampMs: nowMs }),
      getCode: async () => "0x",
      getLogs: async () => [fill],
      getTransactionReceipt: async () => ({ blockHash, logs: [fill] }),
      readContract: async () => {
        throw new Error("not used");
      }
    };

    await runIngestionLoop({
      rpcUrl: "http://localhost:0",
      leaders: [leader],
      dbPath,
      logPath,
      durationMs: 1,
      lookbackBlocks: 10n,
      confirmationDepth: 2,
      aggregationWindowBlocks: 2,
      reorgLookbackBlocks: 64,
      confirmedLogMaxDelayMs: 120_000,
      polygonBlockTimeMs: 2_000,
      risk: {
        copyPct: "0.10",
        maxTradePusdRaw: "1000000",
        maxDailySpendPusdRaw: "5000000",
        maxMarketPositionPusdRaw: "5000000",
        freeBudgetPusdRaw: "5000000",
        maxTradesPerDay: 5,
        maxTradeFractionOfBudgetBps: 5000,
        maxBuyPpm: 980_000,
        minSellPpm: 20_000,
        maxSpreadPpm: 80_000,
        maxDriftPpm: 30_000,
        maxBookParticipationBps: 1500,
        slippageCapPpm: 50_000
      },
      enableSell: false,
      useWebSocket: false,
      maxIterations: 1,
      rpc,
      resolveMetadata: async (tokenId) => ({
        tokenId,
        source: "REST",
        receivedAtMs: Date.now(),
        conditionId: `0x${"a".repeat(64)}` as Hex,
        outcome: "YES",
        negRisk: false,
        active: true,
        resolved: false,
        paused: false,
        tickSize: "0.01",
        tickSizePpm: 10_000,
        minOrderSizeSharesDecimal: "0.000001",
        feeConfig: { r: "0", e: "0", to: `0x${"b".repeat(40)}` as Hex, raw: {} }
      }),
      fetchBook: async () => ({
        spreadPpm: 10_000,
        vwapPpm: 400_000,
        visibleDepthRaw: "1000000",
        intendedSizeRaw: "100000",
        bookSource: "REST",
        wsAgeMs: Number.POSITIVE_INFINITY,
        restAgeMs: 0,
        restCrossCheckPpm: 400_000,
        restCrossCheckAgeMs: 0
      })
    });

    const db = openDatabase(dbPath);
    try {
      expect(db.prepare("SELECT status, skip_reason, approved_copy_notional_raw FROM copy_decisions").get()).toEqual({
        status: "ACTIVE",
        skip_reason: null,
        approved_copy_notional_raw: "40000"
      });
    } finally {
      db.close();
    }
  });

  it("does not group or decide leader-to-leader fills", async () => {
    dir = await mkdtemp(join(tmpdir(), "polycopy-runner-leader-cross-"));
    const dbPath = join(dir, "runner.db");
    const logPath = join(dir, "runner.jsonl");
    const fill = makeChainLog(100n, { maker: leader, taker: secondLeader });

    const rpc: RpcAdapter = {
      getChainId: async () => 137,
      getLatestBlock: async () => ({ number: 104n, hash: blockHash, timestampMs: 1_700_000_000_000 }),
      getBlock: async (number) => ({ number, hash: blockHash, timestampMs: 1_700_000_000_000 }),
      getCode: async () => "0x",
      getLogs: async () => [fill],
      getTransactionReceipt: async () => ({ blockHash, logs: [fill] }),
      readContract: async () => {
        throw new Error("not used");
      }
    };

    const summary = await runIngestionLoop({
      rpcUrl: "http://localhost:0",
      leaders: [leader, secondLeader],
      dbPath,
      logPath,
      durationMs: 1,
      lookbackBlocks: 10n,
      confirmationDepth: 2,
      aggregationWindowBlocks: 2,
      reorgLookbackBlocks: 64,
      confirmedLogMaxDelayMs: 120_000,
      polygonBlockTimeMs: 2_000,
      risk: {
        copyPct: "0.10",
        maxTradePusdRaw: "1000000",
        maxDailySpendPusdRaw: "5000000",
        maxMarketPositionPusdRaw: "5000000",
        freeBudgetPusdRaw: "5000000",
        maxTradesPerDay: 5,
        maxTradeFractionOfBudgetBps: 5000,
        maxBuyPpm: 980_000,
        minSellPpm: 20_000,
        maxSpreadPpm: 80_000,
        maxDriftPpm: 30_000,
        maxBookParticipationBps: 1500,
        slippageCapPpm: 50_000
      },
      enableSell: false,
      useWebSocket: false,
      maxIterations: 1,
      rpc
    });

    expect(summary.decisions).toBe(0);
    expect(summary.sourceFillsAccepted).toBe(0);
    const db = openDatabase(dbPath);
    try {
      expect(db.prepare("SELECT status, skip_reason, source_wallet FROM source_fills").get()).toEqual({
        status: "SKIPPED",
        skip_reason: "ROLE_AMBIGUOUS",
        source_wallet: null
      });
      expect(db.prepare("SELECT COUNT(*) AS count FROM aggregation_groups").get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM copy_decisions").get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("cascades and halts when startup reorg validation finds an orphaned submitted order", async () => {
    dir = await mkdtemp(join(tmpdir(), "polycopy-runner-reorg-"));
    const dbPath = join(dir, "runner.db");
    const logPath = join(dir, "runner.jsonl");
    const storedHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex;
    const canonicalHash = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" as Hex;
    const groupId = stableId("ag", "runner-reorg");
    const decisionId = stableId("cd", groupId);

    const db = openDatabase(dbPath);
    runMigrations(db);
    db.prepare(
      "INSERT INTO runtime_state (key, value, updated_at) VALUES ('last_processed_block', '102', datetime('now'))"
    ).run();
    db.prepare(
      `
        INSERT INTO processed_blocks (id, chain_id, block_number, block_hash, block_timestamp_ms, status, log_count)
        VALUES (?, 137, 100, ?, 1, 'ACTIVE', 0)
      `
    ).run(stableId("pb", storedHash), storedHash);
    db.prepare(
      `
        INSERT INTO aggregation_groups (
          id, chain_id, contract_address, source_wallet, token_id, side,
          window_start_block, window_end_block, reorg_generation, status,
          leader_price_ppm, leader_notional_raw, leader_budget_impact_raw, token_delta_raw, inventory_delta_raw, fee_raw
        ) VALUES (?, 137, ?, ?, '1', 'BUY', 100, 102, 0, 'DECIDED', '1', '1', '1', '1', '0', '0')
      `
    ).run(groupId, CTF_EXCHANGE_V2, leader);
    db.prepare(
      `
        INSERT INTO copy_decisions (
          id, aggregation_group_id, chain_id, contract_address, source_wallet, token_id, side,
          status, leader_price_ppm, leader_notional_raw, leader_budget_impact_raw,
          intended_copy_notional_raw, approved_copy_notional_raw, risk_config_hash, gate_snapshot_json
        ) VALUES (?, ?, 137, ?, ?, '1', 'BUY', 'ACTIVE', '1', '1', '1', '1', '1', 'risk', '{}')
      `
    ).run(decisionId, groupId, CTF_EXCHANGE_V2, leader);
    db.prepare(
      `
        INSERT INTO order_submissions (
          id, copy_decision_id, signed_order_hash, encrypted_signed_payload_json,
          current_state, order_type, limit_price_ppm, intended_notional_raw, intended_size_raw
        ) VALUES (?, ?, ?, '{"ciphertext":"x"}', 'SUBMITTED', 'FAK', '1', '1', '7')
      `
    ).run(stableId("os", decisionId), decisionId, `0x${"4".repeat(64)}`);
    db.close();

    const rpc: RpcAdapter = {
      getChainId: async () => 137,
      getLatestBlock: async () => ({ number: 104n, hash: canonicalHash, timestampMs: 1_700_000_000_000 }),
      getBlock: async (number) => ({
        number,
        hash: number === 100n ? canonicalHash : storedHash,
        timestampMs: 1_700_000_000_000
      }),
      getCode: async () => "0x",
      getLogs: async () => [],
      getTransactionReceipt: async () => ({ blockHash: canonicalHash, logs: [] }),
      readContract: async () => {
        throw new Error("not used");
      }
    };

    const summary = await runIngestionLoop({
      rpcUrl: "http://localhost:0",
      leaders: [leader],
      dbPath,
      logPath,
      durationMs: 1,
      lookbackBlocks: 10n,
      confirmationDepth: 2,
      aggregationWindowBlocks: 2,
      reorgLookbackBlocks: 64,
      confirmedLogMaxDelayMs: 120_000,
      polygonBlockTimeMs: 2_000,
      risk: {
        copyPct: "0.10",
        maxTradePusdRaw: "1000000",
        maxDailySpendPusdRaw: "5000000",
        maxMarketPositionPusdRaw: "5000000",
        freeBudgetPusdRaw: "5000000",
        maxTradesPerDay: 5,
        maxTradeFractionOfBudgetBps: 5000,
        maxBuyPpm: 980_000,
        minSellPpm: 20_000,
        maxSpreadPpm: 80_000,
        maxDriftPpm: 30_000,
        maxBookParticipationBps: 1500,
        slippageCapPpm: 50_000
      },
      enableSell: false,
      useWebSocket: false,
      maxIterations: 1,
      rpc
    });

    expect(summary.errors).toBe(0);
    const checked = openDatabase(dbPath);
    try {
      expect(checked.prepare("SELECT status FROM copy_decisions WHERE id = ?").get(decisionId)).toEqual({
        status: "POST_REORG_ORPHAN"
      });
      expect(checked.prepare("SELECT value FROM runtime_state WHERE key = 'live_halt_reorg_orphan'").get()).toEqual({
        value: "1"
      });
      expect(checked.prepare("SELECT value FROM runtime_state WHERE key = 'last_processed_block'").get()).toEqual({
        value: "99"
      });
    } finally {
      checked.close();
    }
  });

  it("skips a ready group when independent receipt verification disagrees", async () => {
    dir = await mkdtemp(join(tmpdir(), "polycopy-runner-receipt-"));
    const dbPath = join(dir, "runner.db");
    const logPath = join(dir, "runner.jsonl");
    const fill = makeChainLog(100n);
    const disagreementHash = "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" as Hex;

    const rpc: RpcAdapter = {
      getChainId: async () => 137,
      getLatestBlock: async () => ({ number: 104n, hash: blockHash, timestampMs: 1_700_000_000_000 }),
      getBlock: async (number) => ({ number, hash: blockHash, timestampMs: 1_700_000_000_000 }),
      getCode: async () => "0x",
      getLogs: async () => [fill],
      getTransactionReceipt: async () => ({ blockHash, logs: [fill] }),
      readContract: async () => {
        throw new Error("not used");
      }
    };
    const receiptVerificationRpc: RpcAdapter = {
      ...rpc,
      getTransactionReceipt: async () => ({ blockHash: disagreementHash, logs: [fill] })
    };

    await runIngestionLoop({
      rpcUrl: "http://localhost:0",
      leaders: [leader],
      dbPath,
      logPath,
      durationMs: 1,
      lookbackBlocks: 10n,
      confirmationDepth: 2,
      aggregationWindowBlocks: 2,
      reorgLookbackBlocks: 64,
      confirmedLogMaxDelayMs: 120_000,
      polygonBlockTimeMs: 2_000,
      risk: {
        copyPct: "0.10",
        maxTradePusdRaw: "1000000",
        maxDailySpendPusdRaw: "5000000",
        maxMarketPositionPusdRaw: "5000000",
        freeBudgetPusdRaw: "5000000",
        maxTradesPerDay: 5,
        maxTradeFractionOfBudgetBps: 5000,
        maxBuyPpm: 980_000,
        minSellPpm: 20_000,
        maxSpreadPpm: 80_000,
        maxDriftPpm: 30_000,
        maxBookParticipationBps: 1500,
        slippageCapPpm: 50_000
      },
      enableSell: false,
      useWebSocket: false,
      maxIterations: 1,
      rpc,
      receiptVerificationRpc
    });

    const db = openDatabase(dbPath);
    try {
      expect(db.prepare("SELECT status, skip_reason FROM copy_decisions").get()).toEqual({
        status: "SKIPPED",
        skip_reason: "RPC_DISAGREEMENT"
      });
    } finally {
      db.close();
    }
  });
});
