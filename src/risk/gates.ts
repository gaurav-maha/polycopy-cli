import type { MarketMetadata } from "../adapters/types.js";
import type { BookWalkResult } from "../market/book-oracle.js";
import { assertMarketLifecycle, getFixtureMarketMetadata, sharesRawFromNotional, snapTickPpm } from "../market/metadata.js";
import { leaderCopyPct, isLeaderEnabled } from "../config/leaders.js";
import type { Config } from "../config/schema.js";
import { AggregationGroup } from "../normalize/aggregate.js";
import { compactFeeConfig, estimateBuyPusdFeeHeadroomRaw, totalBuyPusdRequiredRaw } from "./fee-headroom.js";
import {
  applyBatchApproval,
  globalDailyRemainingRaw,
  globalFreeBudgetRemainingRaw,
  leaderDailyRemainingRaw,
  tryClaimToken,
  type ContentionKind,
  type DecisionBatchState
} from "./leader-budgets.js";
import { availableSellInventoryRaw } from "./reservations.js";
import { applyDecimalPct, minBigint } from "./size-notional.js";

const sdkMarketOrderMakerQuantumRaw = 10_000n;

export type SkipReason =
  | "SIDE_DISABLED"
  | "STALE_LOG"
  | "STALE_BOOK"
  | "BOOK_GAP"
  | "BOOK_SOURCE_MISMATCH"
  | "DRIFT_BUY"
  | "DRIFT_SELL"
  | "PRICE_ABOVE_MAX_BUY"
  | "PRICE_BELOW_MIN_SELL"
  | "BUDGET"
  | "DAILY_CAP"
  | "SPREAD"
  | "PARTICIPATION"
  | "SUB_MIN"
  | "NO_INVENTORY"
  | "MARKET_PAUSED"
  | "MARKET_RESOLVED"
  | "CACHE_MISMATCH"
  | "RPC_DISAGREEMENT"
  | "CONFIG_INVALID";

export type DryRunDecision =
  | {
      status: "ACTIVE";
      skipReason: null;
      intendedCopyNotionalRaw: string;
      approvedCopyNotionalRaw: string;
      gateSnapshot: Record<string, unknown>;
    }
  | {
      status: "SKIPPED";
      skipReason: SkipReason;
      intendedCopyNotionalRaw: string;
      approvedCopyNotionalRaw: null;
      gateSnapshot: Record<string, unknown>;
    };

export type { BookWalkResult };

type DryRunConfig = {
  config?: Config;
  batch?: DecisionBatchState;
  copy: { enableSell: boolean };
  risk: {
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
  runtime: {
    confirmationDepth: number;
    confirmedLogMaxDelayMs: number;
    polygonBlockTimeMs: number;
  };
  market: {
    metadataMaxAgeMs: number;
    maxPositionAgeMs: number;
    clobCacheMaxAgeMs: number;
    onchainBalanceMaxAgeMs: number;
    balanceMismatchToleranceRaw: string;
  };
  nowMs: number;
  sourceBlockTimestampMs: number;
  resolveMetadata?: (tokenId: string) => Promise<MarketMetadata>;
  fetchBook: (args: { tokenId: string; side: "BUY" | "SELL"; intendedNotionalRaw: bigint }) => Promise<BookWalkResult>;
  inventory?: {
    sharesRaw: string;
    activeSellReservedSharesRaw?: string;
    lastReconciledAtMs: number | null;
  };
  balances?: {
    onchainPusdRaw: string;
    clobPusdRaw: string;
    allowanceRaw: string;
    onchainAgeMs: number;
    clobAgeMs: number;
  };
};

function skipped(
  skipReason: SkipReason,
  intendedCopyNotionalRaw: bigint,
  gateSnapshot: Record<string, unknown>,
  extras?: { leaderWallet?: string; contentionKind?: ContentionKind }
): DryRunDecision {
  if (extras?.leaderWallet) gateSnapshot.leaderWallet = extras.leaderWallet;
  if (extras?.contentionKind) gateSnapshot.contentionKind = extras.contentionKind;
  return {
    status: "SKIPPED",
    skipReason,
    intendedCopyNotionalRaw: intendedCopyNotionalRaw.toString(),
    approvedCopyNotionalRaw: null,
    gateSnapshot
  };
}

function computeNotional(group: AggregationGroup, config: DryRunConfig): bigint {
  const copyPct = config.config ? leaderCopyPct(config.config, group.sourceWallet) : config.risk.copyPct;
  const desired = applyDecimalPct(group.leaderNotionalRaw, copyPct);
  const caps = [
    desired,
    BigInt(config.risk.maxTradePusdRaw),
    BigInt(config.risk.maxDailySpendPusdRaw),
    BigInt(config.risk.maxMarketPositionPusdRaw),
    BigInt(config.risk.freeBudgetPusdRaw)
  ];
  if (config.batch) {
    caps.push(globalFreeBudgetRemainingRaw(config.risk, config.batch));
    caps.push(globalDailyRemainingRaw(config.risk, config.batch));
    if (config.config) {
      caps.push(leaderDailyRemainingRaw(config.config, config.batch, group.sourceWallet, BigInt(config.risk.maxDailySpendPusdRaw)));
    }
  }
  return minBigint(caps);
}

export async function evaluateDryRunDecision(group: AggregationGroup, config: DryRunConfig): Promise<DryRunDecision> {
  const gateSnapshot: Record<string, unknown> = { gateOrder: [] as string[], leaderPricePpm: group.leaderPricePpm };
  const gateOrder = gateSnapshot.gateOrder as string[];
  const leaderPricePpm = Number(group.leaderPricePpm);
  const intendedCopyNotionalRaw = computeNotional(group, config);
  let approvedCopyNotionalRaw = intendedCopyNotionalRaw;

  gateOrder.push("side");
  if (group.side === "SELL" && !config.copy.enableSell) {
    return skipped("SIDE_DISABLED", intendedCopyNotionalRaw, gateSnapshot);
  }

  gateOrder.push("ppm_bounds");
  if (group.side === "BUY" && leaderPricePpm > config.risk.maxBuyPpm) {
    return skipped("PRICE_ABOVE_MAX_BUY", intendedCopyNotionalRaw, gateSnapshot);
  }
  if (group.side === "SELL" && leaderPricePpm < config.risk.minSellPpm) {
    return skipped("PRICE_BELOW_MIN_SELL", intendedCopyNotionalRaw, gateSnapshot);
  }

  gateOrder.push("confirmed_log_delay");
  const expectedConfirmedAtMs =
    config.sourceBlockTimestampMs + config.runtime.polygonBlockTimeMs * config.runtime.confirmationDepth;
  if (config.nowMs - expectedConfirmedAtMs > config.runtime.confirmedLogMaxDelayMs) {
    return skipped("STALE_LOG", intendedCopyNotionalRaw, gateSnapshot);
  }

  if (config.config) {
    gateOrder.push("leader_enabled");
    if (!isLeaderEnabled(config.config, group.sourceWallet)) {
      return skipped("CONFIG_INVALID", intendedCopyNotionalRaw, gateSnapshot, {
        leaderWallet: group.sourceWallet,
        contentionKind: "LEADER"
      });
    }
  }

  if (config.batch && config.config) {
    gateOrder.push("leader_daily_cap");
    const leaderRemaining = leaderDailyRemainingRaw(
      config.config,
      config.batch,
      group.sourceWallet,
      BigInt(config.risk.maxDailySpendPusdRaw)
    );
    if (leaderRemaining <= 0n) {
      return skipped("DAILY_CAP", intendedCopyNotionalRaw, gateSnapshot, {
        leaderWallet: group.sourceWallet,
        contentionKind: "LEADER"
      });
    }

    gateOrder.push("global_daily_cap");
    const globalDailyRemaining = globalDailyRemainingRaw(config.risk, config.batch);
    if (globalDailyRemaining <= 0n) {
      return skipped("DAILY_CAP", intendedCopyNotionalRaw, gateSnapshot, { contentionKind: "GLOBAL" });
    }
  }

  if (intendedCopyNotionalRaw <= 0n) {
    return skipped("BUDGET", intendedCopyNotionalRaw, gateSnapshot, {
      leaderWallet: group.sourceWallet,
      contentionKind: "GLOBAL"
    });
  }

  gateOrder.push("max_trade_fraction");
  if (intendedCopyNotionalRaw > (BigInt(config.risk.freeBudgetPusdRaw) * BigInt(config.risk.maxTradeFractionOfBudgetBps)) / 10_000n) {
    return skipped("BUDGET", intendedCopyNotionalRaw, gateSnapshot, { contentionKind: "GLOBAL" });
  }

  gateOrder.push("market_metadata");
  const metadata = await (config.resolveMetadata?.(group.tokenId) ?? Promise.resolve(getFixtureMarketMetadata(group.tokenId)));
  gateSnapshot.metadata = {
    source: metadata.source,
    receivedAtMs: metadata.receivedAtMs,
    tickSize: metadata.tickSize,
    negRisk: metadata.negRisk,
    feeConfig: compactFeeConfig(metadata.feeConfig)
  };
  if (config.nowMs - metadata.receivedAtMs > config.market.metadataMaxAgeMs) {
    return skipped("STALE_BOOK", intendedCopyNotionalRaw, gateSnapshot);
  }
  const lifecycle = assertMarketLifecycle(metadata);
  if (!lifecycle.ok) {
    return skipped(lifecycle.skipReason, intendedCopyNotionalRaw, gateSnapshot);
  }

  if (group.side === "SELL") {
    gateOrder.push("sell_inventory");
    const inventory = config.inventory;
    if (!inventory) {
      return skipped("NO_INVENTORY", intendedCopyNotionalRaw, gateSnapshot);
    }
    if (inventory.lastReconciledAtMs === null || config.nowMs - inventory.lastReconciledAtMs > config.market.maxPositionAgeMs) {
      return skipped("NO_INVENTORY", intendedCopyNotionalRaw, gateSnapshot);
    }
    const neededShares = sharesRawFromNotional(intendedCopyNotionalRaw, leaderPricePpm);
    const availableShares = availableSellInventoryRaw({
      reconciledSharesRaw: inventory.sharesRaw,
      activeSellReservedSharesRaw: inventory.activeSellReservedSharesRaw ?? "0"
    });
    gateSnapshot.sellInventory = {
      reconciledSharesRaw: inventory.sharesRaw,
      activeSellReservedSharesRaw: inventory.activeSellReservedSharesRaw ?? "0",
      availableSharesRaw: availableShares.toString(),
      neededSharesRaw: neededShares.toString()
    };
    if (availableShares < neededShares) {
      return skipped("NO_INVENTORY", intendedCopyNotionalRaw, gateSnapshot);
    }
  }

  gateOrder.push("book_fetch");
  let book: BookWalkResult;
  try {
    book = await config.fetchBook({ tokenId: group.tokenId, side: group.side, intendedNotionalRaw: intendedCopyNotionalRaw });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    gateSnapshot.bookError = message;
    if (message.includes("BOOK_GAP")) return skipped("BOOK_GAP", intendedCopyNotionalRaw, gateSnapshot);
    if (message.includes("BOOK_SOURCE_MISMATCH")) return skipped("BOOK_SOURCE_MISMATCH", intendedCopyNotionalRaw, gateSnapshot);
    return skipped("STALE_BOOK", intendedCopyNotionalRaw, gateSnapshot);
  }
  gateSnapshot.book = book;

  gateOrder.push("spread");
  if (book.spreadPpm > config.risk.maxSpreadPpm) {
    return skipped("SPREAD", intendedCopyNotionalRaw, gateSnapshot);
  }

  gateOrder.push("participation");
  if (intendedCopyNotionalRaw > (BigInt(book.visibleDepthRaw) * BigInt(config.risk.maxBookParticipationBps)) / 10_000n) {
    return skipped("PARTICIPATION", intendedCopyNotionalRaw, gateSnapshot);
  }

  gateOrder.push("drift");
  if (group.side === "BUY" && book.vwapPpm > leaderPricePpm + config.risk.maxDriftPpm) {
    return skipped("DRIFT_BUY", intendedCopyNotionalRaw, gateSnapshot);
  }
  if (group.side === "SELL" && book.vwapPpm < leaderPricePpm - config.risk.maxDriftPpm) {
    return skipped("DRIFT_SELL", intendedCopyNotionalRaw, gateSnapshot);
  }

  gateOrder.push("sub_min");
  const minShares = BigInt(Math.floor(Number.parseFloat(metadata.minOrderSizeSharesDecimal) * 1_000_000));
  if (BigInt(book.intendedSizeRaw) < minShares) {
    gateSnapshot.minOrderSizeSharesDecimal = metadata.minOrderSizeSharesDecimal;
    return skipped("SUB_MIN", intendedCopyNotionalRaw, gateSnapshot);
  }

  gateOrder.push("tick_snap");
  const limitPpm = snapTickPpm(
    group.side,
    group.side === "BUY"
      ? Math.min(config.risk.maxBuyPpm, leaderPricePpm + config.risk.slippageCapPpm)
      : Math.max(config.risk.minSellPpm, leaderPricePpm - config.risk.slippageCapPpm),
    metadata.tickSizePpm
  );
  gateSnapshot.limitPpm = limitPpm;

  if (group.side === "BUY") {
    gateOrder.push("sdk_amount_granularity");
    const rounded = roundDownToQuantum(approvedCopyNotionalRaw, sdkMarketOrderMakerQuantumRaw);
    if (rounded !== approvedCopyNotionalRaw) {
      gateSnapshot.sdkAmountRounding = {
        rawBefore: approvedCopyNotionalRaw.toString(),
        rawAfter: rounded.toString(),
        quantumRaw: sdkMarketOrderMakerQuantumRaw.toString()
      };
      approvedCopyNotionalRaw = rounded;
    }
    if (approvedCopyNotionalRaw <= 0n) {
      return skipped("SUB_MIN", intendedCopyNotionalRaw, gateSnapshot);
    }
  }

  let feeHeadroomRaw = 0n;
  if (group.side === "BUY") {
    gateOrder.push("fee_headroom");
    feeHeadroomRaw = estimateBuyPusdFeeHeadroomRaw({
      notionalRaw: approvedCopyNotionalRaw,
      limitPricePpm: limitPpm,
      feeConfig: metadata.feeConfig
    });
    gateSnapshot.feeHeadroomRaw = feeHeadroomRaw.toString();
    gateSnapshot.totalBuyRequiredRaw = totalBuyPusdRequiredRaw({
      notionalRaw: approvedCopyNotionalRaw,
      feeHeadroomRaw
    }).toString();
    if (buyCostExceedsBudgets(approvedCopyNotionalRaw, feeHeadroomRaw, group.sourceWallet, config)) {
      return skipped("BUDGET", intendedCopyNotionalRaw, gateSnapshot, { contentionKind: "GLOBAL" });
    }
  }

  if (config.balances) {
    gateOrder.push("balance_cache");
    if (config.balances.onchainAgeMs > config.market.onchainBalanceMaxAgeMs || config.balances.clobAgeMs > config.market.clobCacheMaxAgeMs) {
      return skipped("CACHE_MISMATCH", intendedCopyNotionalRaw, gateSnapshot);
    }
    const tolerance = BigInt(config.market.balanceMismatchToleranceRaw);
    const balanceDelta =
      BigInt(config.balances.onchainPusdRaw) > BigInt(config.balances.clobPusdRaw)
        ? BigInt(config.balances.onchainPusdRaw) - BigInt(config.balances.clobPusdRaw)
        : BigInt(config.balances.clobPusdRaw) - BigInt(config.balances.onchainPusdRaw);
    if (balanceDelta > tolerance) {
      return skipped("CACHE_MISMATCH", intendedCopyNotionalRaw, gateSnapshot);
    }
    const requiredBuyPusdRaw = totalBuyPusdRequiredRaw({
      notionalRaw: approvedCopyNotionalRaw,
      feeHeadroomRaw
    });
    if (group.side === "BUY" && BigInt(config.balances.allowanceRaw) < requiredBuyPusdRaw) {
      return skipped("CACHE_MISMATCH", intendedCopyNotionalRaw, gateSnapshot);
    }
  }

  if (config.batch) {
    gateOrder.push("token_contention");
    if (!tryClaimToken(config.batch, group.tokenId, group.side)) {
      return skipped("BUDGET", intendedCopyNotionalRaw, gateSnapshot, {
        leaderWallet: group.sourceWallet,
        contentionKind: "TOKEN"
      });
    }
    applyBatchApproval(
      config.batch,
      group.sourceWallet,
      totalBuyPusdRequiredRaw({ notionalRaw: approvedCopyNotionalRaw, feeHeadroomRaw })
    );
  }

  return {
    status: "ACTIVE",
    skipReason: null,
    intendedCopyNotionalRaw: intendedCopyNotionalRaw.toString(),
    approvedCopyNotionalRaw: approvedCopyNotionalRaw.toString(),
    gateSnapshot
  };
}

function roundDownToQuantum(value: bigint, quantum: bigint): bigint {
  return (value / quantum) * quantum;
}

function buyCostExceedsBudgets(
  approvedNotionalRaw: bigint,
  feeHeadroomRaw: bigint,
  sourceWallet: `0x${string}`,
  config: DryRunConfig
): boolean {
  const totalRequiredRaw = totalBuyPusdRequiredRaw({ notionalRaw: approvedNotionalRaw, feeHeadroomRaw });
  if (totalRequiredRaw > BigInt(config.risk.freeBudgetPusdRaw)) return true;
  if (totalRequiredRaw > BigInt(config.risk.maxDailySpendPusdRaw)) return true;
  if (!config.batch) return false;
  if (totalRequiredRaw > globalFreeBudgetRemainingRaw(config.risk, config.batch)) return true;
  if (totalRequiredRaw > globalDailyRemainingRaw(config.risk, config.batch)) return true;
  if (config.config) {
    const leaderRemaining = leaderDailyRemainingRaw(
      config.config,
      config.batch,
      sourceWallet,
      BigInt(config.risk.maxDailySpendPusdRaw)
    );
    if (totalRequiredRaw > leaderRemaining) return true;
  }
  return false;
}
