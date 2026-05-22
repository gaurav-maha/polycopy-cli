import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { getAddress } from "viem";
import type { BlockHeadAdapter, Hex, LogSubscriptionAdapter, MarketMetadata, RpcAdapter } from "../adapters/types.js";
import type { Config } from "../config/schema.js";
import { leaderCopyPct } from "../config/leaders.js";
import type { SqliteDatabase } from "../db/client.js";
import { openDatabase } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { closeReadyAggregationGroups, upsertOpenAggregationGroup } from "../pipeline/aggregation-worker.js";
import { sortAggregationGroupsForDecision } from "../normalize/aggregate.js";
import { evaluateDryRunDecision } from "../risk/gates.js";
import { sellInventoryForGates } from "../risk/inventory.js";
import { loadDecisionBatchState } from "../risk/leader-budgets.js";
import { applyDecimalPct, minBigint } from "../risk/size-notional.js";
import { fetchPublicClobBookWalk } from "../dry-run/book.js";
import type { BookWalkResult } from "../market/book-oracle.js";
import { writeJsonl } from "../logging/jsonl.js";
import { createAlchemyWsAdapters } from "./alchemy-ws.js";
import { catchUpLogs, createHttpRpcAdapter } from "./catch-up.js";
import { readLastProcessedBlock, safeHead, writeLastProcessedBlock } from "./cursor.js";
import { insertCopyDecision } from "./decisions.js";
import { chainLogFromViem, toRawOrderFilledLog } from "./log-utils.js";
import {
  cascadeReorg,
  detectReorgedBlockNumbers,
  ingestRawLog,
  promotePendingFills
} from "./pending-fills.js";
import { verifyGroupSourceFillReceipts } from "./receipt-verification.js";
import { resolveWsUrl } from "./rpc-url.js";
import { CTF_EXCHANGE_V2, NEG_RISK_CTF_EXCHANGE_V2 } from "../constants/chain.js";

export type IngestionRiskConfig = {
  copyPct: string;
  maxTradePusdRaw: string;
  maxDailySpendPusdRaw: string;
  maxMarketPositionPusdRaw: string;
  freeBudgetPusdRaw: string;
  maxTradesPerDay: number;
  maxTradeFractionOfBudgetBps: number;
  maxBuyPpm: number;
  minSellPpm: number;
  maxSpreadPpm: number;
  maxDriftPpm: number;
  maxBookParticipationBps: number;
  slippageCapPpm: number;
};

export type LeaderSummary = {
  decisions: number;
  approved: number;
  skipped: number;
};

export type IngestionRunnerArgs = {
  rpcUrl: string;
  wsUrl?: string;
  leaders: Hex[];
  config?: Config;
  dbPath: string;
  logPath: string;
  durationMs: number;
  lookbackBlocks: bigint;
  confirmationDepth: number;
  aggregationWindowBlocks: number;
  reorgLookbackBlocks: number;
  confirmedLogMaxDelayMs: number;
  polygonBlockTimeMs: number;
  risk: IngestionRiskConfig;
  enableSell: boolean;
  pollMs?: number;
  maxIterations?: number;
  useWebSocket?: boolean;
  subscriptions?: {
    logs: LogSubscriptionAdapter;
    blockHead: BlockHeadAdapter;
  };
  rpc?: RpcAdapter;
  receiptVerificationRpc?: RpcAdapter;
  resolveMetadata?: (tokenId: string) => Promise<MarketMetadata>;
  fetchBook?: (args: { tokenId: string; side: "BUY" | "SELL"; intendedNotionalRaw: bigint }) => Promise<BookWalkResult>;
  db?: SqliteDatabase;
  onAfterCommit?: (ctx: { db: SqliteDatabase; summary: IngestionSummary }) => Promise<{ halt?: boolean } | void>;
  shouldHalt?: () => boolean | Promise<boolean>;
};

export type IngestionSummary = {
  startedAt: string;
  finishedAt: string;
  iterations: number;
  rangesProcessed: number;
  logsSeen: number;
  sourceFillsAccepted: number;
  decisions: number;
  approved: number;
  skipped: number;
  errors: number;
  fromBlock: string | null;
  toBlock: string | null;
  transport: "http-fallback" | "websocket";
  byLeader: Record<string, LeaderSummary>;
};

function normalizeLeaders(leaders: Hex[]): Hex[] {
  return [...new Set(leaders.map((leader) => getAddress(leader) as Hex))];
}

function leaderSummaryKey(leader: Hex): string {
  return getAddress(leader).toLowerCase();
}

function ensureLeaderSummary(summary: IngestionSummary, leader: Hex): LeaderSummary {
  const key = leaderSummaryKey(leader);
  summary.byLeader[key] ??= { decisions: 0, approved: 0, skipped: 0 };
  return summary.byLeader[key]!;
}

function intendedNotional(
  group: { leaderNotionalRaw: string; sourceWallet: Hex },
  risk: IngestionRiskConfig,
  config?: Config
): bigint {
  const copyPct = config ? leaderCopyPct(config, group.sourceWallet) : risk.copyPct;
  return minBigint([
    applyDecimalPct(group.leaderNotionalRaw, copyPct),
    BigInt(risk.maxTradePusdRaw),
    BigInt(risk.maxDailySpendPusdRaw),
    BigInt(risk.maxMarketPositionPusdRaw),
    BigInt(risk.freeBudgetPusdRaw)
  ]);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function processReadyGroups(
  db: SqliteDatabase,
  rpc: RpcAdapter,
  args: IngestionRunnerArgs,
  safeHeadBlock: number,
  summary: IngestionSummary
): Promise<void> {
  const readyGroups = sortAggregationGroupsForDecision(closeReadyAggregationGroups(db, safeHeadBlock));
  const nowMs = Date.now();
  const batch = loadDecisionBatchState(db, { nowMs, leaders: args.leaders });

  for (const group of readyGroups) {
    if (args.receiptVerificationRpc) {
      const receiptVerification = await verifyGroupSourceFillReceipts(db, args.receiptVerificationRpc, group.sourceFillIds);
      if (!receiptVerification.ok) {
        const leaderStats = ensureLeaderSummary(summary, group.sourceWallet);
        const decision = {
          status: "SKIPPED" as const,
          skipReason: "RPC_DISAGREEMENT" as const,
          intendedCopyNotionalRaw: "0",
          approvedCopyNotionalRaw: null,
          gateSnapshot: { gateOrder: ["receipt_tuple"], receiptVerification }
        };
        await insertCopyDecision(db, group, decision);
        summary.decisions += 1;
        summary.skipped += 1;
        summary.sourceFillsAccepted += group.sourceFillIds.length;
        leaderStats.decisions += 1;
        leaderStats.skipped += 1;
        await writeJsonl(args.logPath, {
          event: "copy_decision_created",
          groupId: group.id,
          sourceWallet: group.sourceWallet,
          status: decision.status,
          skipReason: decision.skipReason,
          receiptVerification
        });
        continue;
      }
    }
    const sourceBlock = await rpc.getBlock(BigInt(group.windowStartBlock));
    const notional = intendedNotional(group, args.risk, args.config);
    const leaderStats = ensureLeaderSummary(summary, group.sourceWallet);
    const market = args.config?.market ?? {
      metadataMaxAgeMs: 60_000,
      maxPositionAgeMs: 300_000,
      clobCacheMaxAgeMs: 60_000,
      onchainBalanceMaxAgeMs: 120_000,
      balanceMismatchToleranceRaw: "0"
    };
    const inventory =
      args.enableSell && group.side === "SELL"
        ? sellInventoryForGates(db, {
            tokenId: group.tokenId,
            nowMs,
            maxPositionAgeMs: market.maxPositionAgeMs
          })
        : undefined;
    const decision = await evaluateDryRunDecision(group, {
      config: args.config,
      batch,
      copy: { enableSell: args.enableSell },
      risk: args.risk,
      runtime: {
        confirmationDepth: args.confirmationDepth,
        confirmedLogMaxDelayMs: args.confirmedLogMaxDelayMs,
        polygonBlockTimeMs: args.polygonBlockTimeMs
      },
      market,
      inventory,
      nowMs,
      sourceBlockTimestampMs: sourceBlock.timestampMs,
      resolveMetadata: args.resolveMetadata,
      fetchBook:
        args.fetchBook ??
        ((request) =>
          fetchPublicClobBookWalk({
            tokenId: request.tokenId,
            side: request.side,
            intendedNotionalRaw: request.intendedNotionalRaw.toString()
          }))
    });
    await insertCopyDecision(db, group, decision);
    summary.decisions += 1;
    leaderStats.decisions += 1;
    summary.sourceFillsAccepted += group.sourceFillIds.length;
    if (decision.status === "ACTIVE") {
      summary.approved += 1;
      leaderStats.approved += 1;
    }
    if (decision.status === "SKIPPED") {
      summary.skipped += 1;
      leaderStats.skipped += 1;
    }
    await writeJsonl(args.logPath, {
      event: "copy_decision_created",
      groupId: group.id,
      sourceWallet: group.sourceWallet,
      status: decision.status,
      skipReason: decision.skipReason,
      approvedCopyNotionalRaw: decision.approvedCopyNotionalRaw
    });
  }
}

async function commitAtSafeHead(
  db: SqliteDatabase,
  rpc: RpcAdapter,
  args: IngestionRunnerArgs,
  latest: bigint,
  summary: IngestionSummary
): Promise<{ halt: boolean }> {
  const head = safeHead(latest, args.confirmationDepth);
  if (head === 0n) return { halt: false };

  const reorgFrom = head > BigInt(args.reorgLookbackBlocks) ? head - BigInt(args.reorgLookbackBlocks) : 0n;
  const reorged = await detectReorgedBlockNumbers(db, rpc, { fromBlock: reorgFrom, toBlock: head });
  if (reorged.length > 0) {
    const rollbackFromBlock = Math.min(...reorged);
    const cursorBefore = Number(readLastProcessedBlock(db) ?? head);
    const cascade = cascadeReorg(db, {
      rollbackFromBlock,
      cursorBefore,
      safeHead: Number(head)
    });
    await writeJsonl(args.logPath, { event: "reorg_cascade", blocks: reorged, ...cascade });
    return { halt: false };
  }

  const promoted = await promotePendingFills(db, rpc, { sourceWallets: args.leaders, safeHead: head });
  for (const fill of promoted) {
    upsertOpenAggregationGroup(db, fill, {
      aggregationWindowBlocks: args.aggregationWindowBlocks,
      reorgGeneration: 0
    });
  }
  summary.rangesProcessed += 1;
  summary.toBlock = head.toString();
  await processReadyGroups(db, rpc, args, Number(head), summary);
  writeLastProcessedBlock(db, head);
  if (args.onAfterCommit) {
    const result = await args.onAfterCommit({ db, summary });
    return { halt: Boolean(result?.halt) };
  }
  return { halt: false };
}

async function handleDetectedLog(
  db: SqliteDatabase,
  rpc: RpcAdapter,
  args: IngestionRunnerArgs,
  raw: ReturnType<typeof toRawOrderFilledLog>,
  blockTimestampMs: number,
  summary: IngestionSummary
): Promise<void> {
  summary.logsSeen += 1;
  const { inserted, decoded } = ingestRawLog(db, raw, blockTimestampMs);
  if (!inserted) return;
  await writeJsonl(args.logPath, {
    event: "source_fill_pending",
    txHash: decoded.txHash,
    blockNumber: decoded.blockNumber.toString(),
    sourceWallet: decoded.maker,
    tokenId: decoded.tokenId,
    side: decoded.side
  });
  const latest = await rpc.getLatestBlock();
  await commitAtSafeHead(db, rpc, args, latest.number, summary);
}

export async function runIngestionLoop(args: IngestionRunnerArgs): Promise<IngestionSummary> {
  await mkdir(dirname(args.dbPath), { recursive: true, mode: 0o700 });
  await mkdir(dirname(args.logPath), { recursive: true, mode: 0o700 });

  const ownsDatabase = args.db === undefined;
  const db = args.db ?? openDatabase(args.dbPath);
  if (ownsDatabase) {
    runMigrations(db);
  }
  const rpc = args.rpc ?? createHttpRpcAdapter(args.rpcUrl);
  const leaders = normalizeLeaders(args.leaders);
  if (leaders.length === 0) {
    throw new Error("runIngestionLoop requires at least one leader wallet");
  }
  const startedAtMs = Date.now();
  const summary: IngestionSummary = {
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(startedAtMs).toISOString(),
    iterations: 0,
    rangesProcessed: 0,
    logsSeen: 0,
    sourceFillsAccepted: 0,
    decisions: 0,
    approved: 0,
    skipped: 0,
    errors: 0,
    fromBlock: null,
    toBlock: null,
    transport: args.useWebSocket === false ? "http-fallback" : "websocket",
    byLeader: {}
  };

  const useWs = args.useWebSocket !== false;
  let unwatchLogs: (() => void) | undefined;
  let unwatchHead: (() => void) | undefined;
  const inFlight = new Set<Promise<void>>();

  const track = (work: Promise<void>): void => {
    inFlight.add(work);
    void work.finally(() => {
      inFlight.delete(work);
    });
  };

  try {
    const latest = await rpc.getLatestBlock();
    const head = safeHead(latest.number, args.confirmationDepth);
    const cursor = readLastProcessedBlock(db);
    const fromBlock =
      cursor === null
        ? head > args.lookbackBlocks
          ? head - args.lookbackBlocks
          : 0n
        : cursor + 1n;
    summary.fromBlock = fromBlock.toString();

    const caughtUp = await catchUpLogs({ rpc, db, leaders, fromBlock, toBlock: head });
    await writeJsonl(args.logPath, {
      event: "ingestion_catch_up",
      fromBlock: fromBlock.toString(),
      toBlock: head.toString(),
      inserted: caughtUp,
      leaders
    });
    const initialCommit = await commitAtSafeHead(db, rpc, args, latest.number, summary);
    if (initialCommit.halt) {
      summary.finishedAt = new Date().toISOString();
      return summary;
    }

    if (useWs) {
      const wsUrl = resolveWsUrl({ wsUrl: args.wsUrl, rpcUrl: args.rpcUrl });
      const adapters = args.subscriptions ?? createAlchemyWsAdapters(wsUrl);
      summary.transport = "websocket";

      unwatchLogs = await adapters.logs.subscribeOrderFilled({
        leaders,
        exchangeAddresses: [CTF_EXCHANGE_V2, NEG_RISK_CTF_EXCHANGE_V2],
        onLog: (chainLog) => {
          const work = (async () => {
            summary.iterations += 1;
            const block = await rpc.getBlock(chainLog.blockNumber);
            await handleDetectedLog(db, rpc, args, toRawOrderFilledLog(chainLog), block.timestampMs, summary);
          })().catch(async (error) => {
            summary.errors += 1;
            await writeJsonl(args.logPath, { event: "ingestion_error", stage: "detect", error: String(error) });
          });
          track(work);
          return work;
        }
      });

      unwatchHead = await adapters.blockHead.watchBlockHead((blockRef) => {
        const work = (async () => {
          summary.iterations += 1;
          await commitAtSafeHead(db, rpc, args, blockRef.number, summary);
        })().catch(async (error) => {
          summary.errors += 1;
          await writeJsonl(args.logPath, { event: "ingestion_error", stage: "commit", error: String(error) });
        });
        track(work);
        return work;
      });

      while (Date.now() - startedAtMs < args.durationMs) {
        if (summary.iterations >= (args.maxIterations ?? Number.MAX_SAFE_INTEGER)) break;
        if (args.shouldHalt && (await args.shouldHalt())) break;
        await sleep(250);
      }
    } else {
      summary.transport = "http-fallback";
      const pollMs = args.pollMs ?? 10_000;
      while (Date.now() - startedAtMs < args.durationMs) {
        if (args.shouldHalt && (await args.shouldHalt())) break;
        summary.iterations += 1;
        const tip = await rpc.getLatestBlock();
        const safe = safeHead(tip.number, args.confirmationDepth);
        const cursorNow = readLastProcessedBlock(db) ?? fromBlock - 1n;
        const rangeFrom = cursorNow + 1n;
        if (rangeFrom <= safe) {
          await catchUpLogs({ rpc, db, leaders, fromBlock: rangeFrom, toBlock: safe });
          const commit = await commitAtSafeHead(db, rpc, args, tip.number, summary);
          if (commit.halt) break;
        }
        if (summary.iterations >= (args.maxIterations ?? Number.MAX_SAFE_INTEGER)) break;
        await sleep(pollMs);
      }
    }
  } finally {
    unwatchLogs?.();
    unwatchHead?.();
    await Promise.allSettled([...inFlight]);
    if (ownsDatabase) {
      db.close();
    }
  }

  summary.finishedAt = new Date().toISOString();
  return summary;
}
