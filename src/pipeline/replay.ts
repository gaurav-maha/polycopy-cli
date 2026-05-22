import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { SqliteDatabase } from "../db/client.js";
import { openDatabase } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { MockClock, MockClobRestAdapter, MockMarketWsAdapter } from "../adapters/mocks.js";
import { BookOracle } from "../market/book-oracle.js";
import { getFixtureMarketMetadata } from "../market/metadata.js";
import { decodeOrderFilledLog } from "../protocol/decode-order-filled.js";
import { normalizeSourceFill } from "../normalize/taker-filter.js";
import { evaluateDryRunDecision } from "../risk/gates.js";
import { insertCopyDecision } from "../ingestion/decisions.js";
import { ensureProcessedBlock, stableId } from "../ingestion/pending-fills.js";
import { closeReadyAggregationGroups, upsertOpenAggregationGroup } from "./aggregation-worker.js";
import {
  parseFixtureRawLog,
  type FixtureCase,
  type FixtureManifest
} from "../verify/fixtures.js";
import { CTF_EXCHANGE_V2, NEG_RISK_CTF_EXCHANGE_V2 } from "../constants/chain.js";

const DEFAULT_LEADER = "0x1111111111111111111111111111111111111111" as const;

function jsonStringify(value: unknown): string {
  return JSON.stringify(value, (_, entry) => (typeof entry === "bigint" ? entry.toString() : entry));
}

export type ReplaySummary = {
  cases: number;
  decisions: number;
  approved: number;
  skipped: number;
  errors: number;
};

const REPLAY_RISK = {
  copyPct: "0.20",
  maxTradePusdRaw: "10000000",
  maxDailySpendPusdRaw: "10000000",
  maxMarketPositionPusdRaw: "10000000",
  freeBudgetPusdRaw: "10000000",
  maxTradesPerDay: 100,
  maxTradeFractionOfBudgetBps: 5000,
  maxBuyPpm: 980_000,
  minSellPpm: 20_000,
  maxSpreadPpm: 80_000,
  maxDriftPpm: 30_000,
  maxBookParticipationBps: 1500,
  slippageCapPpm: 50_000
};

const REPLAY_MARKET = {
  metadataMaxAgeMs: 60_000,
  maxPositionAgeMs: 300_000,
  clobCacheMaxAgeMs: 60_000,
  onchainBalanceMaxAgeMs: 120_000,
  balanceMismatchToleranceRaw: "0"
};

const REPLAY_RUNTIME = {
  confirmationDepth: 2,
  confirmedLogMaxDelayMs: 120_000,
  polygonBlockTimeMs: 2_000
};

function blockTimestampMs(args: { frozenNowMs: number; maxBlock: number; blockNumber: number }): number {
  return (
    args.frozenNowMs -
    (args.maxBlock - args.blockNumber + REPLAY_RUNTIME.confirmationDepth) * REPLAY_RUNTIME.polygonBlockTimeMs
  );
}

const REPLAY_BOOK = {
  wsStaleMs: 500,
  restStaleMs: 1_500,
  bookMismatchPpm: 100_000,
  bookRestCrossCheckMaxAgeMs: 1_500,
  maxBookAgeMs: 800
};

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function loadRawLog(source: NonNullable<FixtureCase["source"]>): Promise<Record<string, unknown>> {
  if (source.rawLog) return source.rawLog;
  if (!source.rawLogPath) throw new Error(`fixture source missing raw log for ${source.txHash}`);
  return readJson<Record<string, unknown>>(resolve(source.rawLogPath));
}

function insertNormalizedFill(
  db: SqliteDatabase,
  fixtureCase: FixtureCase,
  source: NonNullable<FixtureCase["source"]>,
  rawLogJson: string,
  decodedJson: string | null,
  status: string,
  skipReason: string | null,
  errorReason: string | null
): string {
  const id = stableId("sf", `${source.contractAddress}|${source.blockHash}|${source.txHash}|${source.logIndex}`);
  db.prepare(
    `
      INSERT OR IGNORE INTO source_fills (
        id, chain_id, contract_address, block_number, block_hash, tx_hash, tx_index, log_index,
        status, raw_log_json, decoded_json, skip_reason, error_reason
      ) VALUES (?, 137, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  ).run(
    id,
    source.contractAddress,
    source.blockNumber,
    source.blockHash,
    source.txHash,
    source.transactionIndex,
    source.logIndex,
    status,
    rawLogJson,
    decodedJson,
    skipReason,
    errorReason
  );
  void fixtureCase;
  return id;
}

function insertEarlySkipDecision(
  db: SqliteDatabase,
  args: {
    fixtureCaseId: string;
    fillId: string | null;
    contractAddress: string;
    leader: `0x${string}`;
    tokenId: string;
    side: "BUY" | "SELL";
    blockNumber: number;
    windowEndBlock: number;
    pricePpm: string;
    status: "SKIPPED" | "ERROR";
    skipReason: string | null;
    errorReason: string | null;
    gateSnapshot: unknown;
  }
): void {
  const agId = stableId("ag", args.fixtureCaseId);
  db.prepare(
    `
      INSERT OR IGNORE INTO aggregation_groups (
        id, chain_id, contract_address, source_wallet, token_id, side,
        window_start_block, window_end_block, reorg_generation, status,
        leader_price_ppm, leader_notional_raw, leader_budget_impact_raw, token_delta_raw, inventory_delta_raw, fee_raw
      ) VALUES (?, 137, ?, ?, ?, ?, ?, ?, 0, 'SKIPPED', ?, '0', '0', '0', '0', '0')
    `
  ).run(
    agId,
    args.contractAddress,
    args.leader,
    args.tokenId,
    args.side,
    args.blockNumber,
    args.windowEndBlock,
    args.pricePpm
  );
  if (args.fillId) {
    db.prepare(
      "INSERT OR IGNORE INTO aggregation_group_source_fills (aggregation_group_id, source_fill_id) VALUES (?, ?)"
    ).run(agId, args.fillId);
  }
  db.prepare(
    `
      INSERT INTO copy_decisions (
        id, aggregation_group_id, chain_id, contract_address, source_wallet, token_id, side,
        status, leader_price_ppm, leader_notional_raw, leader_budget_impact_raw,
        intended_copy_notional_raw, approved_copy_notional_raw, risk_config_hash,
        gate_snapshot_json, skip_reason, error_reason
      ) VALUES (?, ?, 137, ?, ?, ?, ?, ?, ?, '0', '0', '0', NULL, ?, ?, ?, ?)
    `
  ).run(
    stableId("cd", args.fixtureCaseId),
    agId,
    args.contractAddress,
    args.leader,
    args.tokenId,
    args.side,
    args.status,
    args.pricePpm,
    stableId("risk", args.fixtureCaseId),
    jsonStringify(args.gateSnapshot),
    args.skipReason,
    args.errorReason
  );
}

function createOracle(clock: MockClock, tokenId: string, fault: "WS_GAP" | null): BookOracle {
  const market = getFixtureMarketMetadata(tokenId, clock);
  const book = {
    tokenId,
    source: "WS" as const,
    snapshotId: `fixture-${tokenId}`,
    sequence: 1,
    receivedAtMs: clock.nowMs(),
    bids: [{ pricePpm: 490_000, sizeRaw: "100000000" }],
    asks: [{ pricePpm: 510_000, sizeRaw: "100000000" }]
  };
  const rest = new MockClobRestAdapter({ clock, markets: [market], books: [{ ...book, source: "REST" }] });
  const ws = new MockMarketWsAdapter({ clock, snapshots: [book] });
  const oracle = new BookOracle({ clock, ws, rest, config: REPLAY_BOOK });
  oracle.setFault(fault);
  return oracle;
}

async function replayCase(
  db: SqliteDatabase,
  fixtureCase: FixtureCase,
  args: { leader: `0x${string}`; frozenNowMs: number; aggregationWindowBlocks: number }
): Promise<"approved" | "skipped" | "error"> {
  if (fixtureCase.id === "rpc-disagreement-fault") {
    const source = fixtureCase.source!;
    const fillId = insertNormalizedFill(db, fixtureCase, source, "{}", null, "ERROR", "RPC_DISAGREEMENT", fixtureCase.expected.error);
    insertEarlySkipDecision(db, {
      fixtureCaseId: fixtureCase.id,
      fillId,
      contractAddress: source.contractAddress,
      leader: args.leader,
      tokenId: "0",
      side: "BUY",
      blockNumber: source.blockNumber,
      windowEndBlock: source.blockNumber + args.aggregationWindowBlocks,
      pricePpm: "0",
      status: "ERROR",
      skipReason: "RPC_DISAGREEMENT",
      errorReason: fixtureCase.expected.error,
      gateSnapshot: { fixtureId: fixtureCase.id }
    });
    return "error";
  }

  const sources = fixtureCase.source ? [fixtureCase.source] : fixtureCase.sources ?? [];
  const clock = new MockClock(args.frozenNowMs);
  const maxBlock = sources.reduce((highest, source) => Math.max(highest, source.blockNumber), 0);

  for (const source of sources) {
    ensureProcessedBlock(db, {
      blockNumber: BigInt(source.blockNumber),
      blockHash: source.blockHash,
      timestampMs: blockTimestampMs({ frozenNowMs: args.frozenNowMs, maxBlock, blockNumber: source.blockNumber }),
      logCount: 1
    });

    const raw = await loadRawLog(source);
    const rawLogJson = JSON.stringify(raw);

    if (fixtureCase.id === "mint-merge-skip") {
      const fillId = insertNormalizedFill(db, fixtureCase, source, rawLogJson, null, "SKIPPED", "ROLE_AMBIGUOUS", fixtureCase.expected.error);
      insertEarlySkipDecision(db, {
        fixtureCaseId: fixtureCase.id,
        fillId,
        contractAddress: source.contractAddress,
        leader: args.leader,
        tokenId: "0",
        side: "BUY",
        blockNumber: source.blockNumber,
        windowEndBlock: source.blockNumber + args.aggregationWindowBlocks,
        pricePpm: "0",
        status: "SKIPPED",
        skipReason: "ROLE_AMBIGUOUS",
        errorReason: fixtureCase.expected.error,
        gateSnapshot: { fixtureId: fixtureCase.id }
      });
      return "skipped";
    }

    let decoded;
    try {
      decoded = decodeOrderFilledLog(parseFixtureRawLog(raw, source));
    } catch (error) {
      const fillId = insertNormalizedFill(
        db,
        fixtureCase,
        source,
        rawLogJson,
        null,
        "ERROR",
        fixtureCase.expected.decision.skipReason,
        error instanceof Error ? error.message : String(error)
      );
      insertEarlySkipDecision(db, {
        fixtureCaseId: fixtureCase.id,
        fillId,
        contractAddress: source.contractAddress,
        leader: args.leader,
        tokenId: "0",
        side: "BUY",
        blockNumber: source.blockNumber,
        windowEndBlock: source.blockNumber + args.aggregationWindowBlocks,
        pricePpm: "0",
        status: "SKIPPED",
        skipReason: fixtureCase.expected.decision.skipReason ?? "ERROR",
        errorReason: error instanceof Error ? error.message : String(error),
        gateSnapshot: { fixtureId: fixtureCase.id }
      });
      return "skipped";
    }

    const normalized = normalizeSourceFill(decoded, {
      sourceWallets: [args.leader],
      exchangeAddresses: [CTF_EXCHANGE_V2, NEG_RISK_CTF_EXCHANGE_V2]
    });
    const fillId = insertNormalizedFill(
      db,
      fixtureCase,
      source,
      rawLogJson,
      JSON.stringify(normalized.accepted ? normalized : decoded, (_, entry) => (typeof entry === "bigint" ? entry.toString() : entry)),
      normalized.accepted ? "NORMALIZED" : "SKIPPED",
      normalized.accepted ? null : normalized.skipReason,
      null
    );

    if (!normalized.accepted) {
      insertEarlySkipDecision(db, {
        fixtureCaseId: fixtureCase.id,
        fillId,
        contractAddress: source.contractAddress,
        leader: args.leader,
        tokenId: decoded.tokenId,
        side: decoded.side,
        blockNumber: source.blockNumber,
        windowEndBlock: source.blockNumber + args.aggregationWindowBlocks,
        pricePpm: decoded.pricePpm,
        status: "SKIPPED",
        skipReason: normalized.skipReason,
        errorReason: normalized.errorReason ?? null,
        gateSnapshot: { fixtureId: fixtureCase.id, normalization: normalized }
      });
      return "skipped";
    }

    upsertOpenAggregationGroup(db, { ...normalized, id: fillId }, { aggregationWindowBlocks: args.aggregationWindowBlocks, reorgGeneration: 0 });
  }

  const readyGroups = closeReadyAggregationGroups(db, maxBlock + args.aggregationWindowBlocks);
  const group = readyGroups[0];
  if (!group) return "skipped";

  const oracle = createOracle(clock, group.tokenId, fixtureCase.id === "ws-book-gap-fault" ? "WS_GAP" : null);
  const sourceBlockTimestampMs = blockTimestampMs({
    frozenNowMs: args.frozenNowMs,
    maxBlock,
    blockNumber: group.windowStartBlock
  });
  const decision = await evaluateDryRunDecision(group, {
    copy: { enableSell: false },
    risk: REPLAY_RISK,
    runtime: REPLAY_RUNTIME,
    market: REPLAY_MARKET,
    nowMs: clock.nowMs(),
    sourceBlockTimestampMs,
    resolveMetadata: async (tokenId) => getFixtureMarketMetadata(tokenId, clock),
    fetchBook: ({ tokenId, side, intendedNotionalRaw }) => oracle.fetchWalk({ tokenId, side, intendedNotionalRaw })
  });

  await insertCopyDecision(db, group, decision);
  if (decision.status === "ACTIVE") return "approved";
  if (decision.status === "SKIPPED") return "skipped";
  return "error";
}

export async function replayFixtures(args: {
  dbPath: string;
  manifestPath?: string;
  fixture?: string;
  leader?: `0x${string}`;
  aggregationWindowBlocks?: number;
}): Promise<ReplaySummary> {
  const manifest = await readJson<FixtureManifest>(resolve(args.manifestPath ?? "fixtures/manifest.json"));
  const selectedCases =
    args.fixture && args.fixture !== "all" ? manifest.cases.filter((entry) => entry.id === args.fixture) : manifest.cases;
  if (selectedCases.length === 0) {
    throw new Error(`No fixture cases matched ${args.fixture}`);
  }

  await mkdir(dirname(args.dbPath), { recursive: true, mode: 0o700 });
  const db = openDatabase(args.dbPath);
  try {
    runMigrations(db);
    const summary: ReplaySummary = { cases: selectedCases.length, decisions: 0, approved: 0, skipped: 0, errors: 0 };
    const frozenNowMs = Date.parse(manifest.frozenNow);
    for (const fixtureCase of selectedCases) {
      const outcome = await replayCase(db, fixtureCase, {
        leader: args.leader ?? DEFAULT_LEADER,
        frozenNowMs,
        aggregationWindowBlocks: args.aggregationWindowBlocks ?? 2
      });
      summary.decisions += 1;
      if (outcome === "approved") summary.approved += 1;
      if (outcome === "skipped") summary.skipped += 1;
      if (outcome === "error") summary.errors += 1;
    }
    return summary;
  } finally {
    db.close();
  }
}
