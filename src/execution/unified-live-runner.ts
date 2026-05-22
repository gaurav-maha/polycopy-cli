import type { ClobRestAdapter, Hex, RpcAdapter } from "../adapters/types.js";
import type { Config } from "../config/schema.js";
import type { SqliteDatabase } from "../db/client.js";
import { runIngestionLoop, type IngestionRiskConfig, type IngestionSummary } from "../ingestion/runner.js";
import { createHttpRpcAdapter } from "../ingestion/catch-up.js";
import { resolveWsUrl } from "../ingestion/rpc-url.js";
import { acquireLock } from "../runtime/lockfile.js";
import { writeJsonl } from "../logging/jsonl.js";
import {
  breakerThresholdsFromConfig,
  evaluateLiveCycleBreakers,
  haltLiveTrading,
  readLiveHaltReason
} from "./circuit-breaker.js";
import { runLiveTradingCycle, type LiveOrderSigner, type LiveTradingCycleResult } from "./live-runner.js";
import { signBoundaryConfigFromRiskAndMarket } from "../risk/sign-boundary-gate.js";
import { runOrderRecoveryCycle, type OrderRecoveryCycleResult } from "./recovery.js";

export type UnifiedLiveLoopArgs = {
  config: Config;
  db: SqliteDatabase;
  leaders: Hex[];
  rpcUrl: string;
  wsUrl?: string;
  receiptVerificationRpcUrl?: string;
  logPath: string;
  durationMs: number;
  pollMs: number;
  lookbackBlocks: bigint;
  useWebSocket?: boolean;
  risk: IngestionRiskConfig;
  enableSell: boolean;
  clob: ClobRestAdapter;
  signer: LiveOrderSigner;
  rpc: RpcAdapter;
  receiptVerificationRpc?: RpcAdapter;
  owner: Hex;
  funder: Hex;
  signatureType: 0 | 1 | 3;
  encryptionKey: Uint8Array;
  lockPath: string;
  killSwitchActive: () => boolean | Promise<boolean>;
  skipIngestion?: boolean;
  maxLiveCycles?: number;
};

export type UnifiedLiveSummary = {
  mode: "unified" | "submit-only";
  ingestion: IngestionSummary | null;
  recovery: OrderRecoveryCycleResult | null;
  liveCycles: LiveTradingCycleResult[];
  halted: boolean;
  haltReason: string | null;
};

export async function runUnifiedLiveLoop(args: UnifiedLiveLoopArgs): Promise<UnifiedLiveSummary> {
  const releaseLock = await acquireLock(args.lockPath);
  const nowIso = new Date().toISOString();
  const summary: UnifiedLiveSummary = {
    mode: args.skipIngestion ? "submit-only" : "unified",
    ingestion: null,
    recovery: null,
    liveCycles: [],
    halted: false,
    haltReason: null
  };

  let halted = false;
  let haltReason: string | null = readLiveHaltReason(args.db);

  try {
    const breakerThresholds = breakerThresholdsFromConfig(args.config.risk);
    summary.recovery = await runOrderRecoveryCycle(args.db, {
      clob: args.clob,
      rpc: args.rpc,
      owner: args.owner,
      funder: args.funder,
      signatureType: args.signatureType,
      encryptionKey: args.encryptionKey,
      maxRecoveryAttempts: args.config.runtime.maxRecoveryAttempts,
      breakerThresholds,
      signBoundary: signBoundaryConfigFromRiskAndMarket(args.config.risk, args.config.market),
      killSwitchActive: args.killSwitchActive,
      nowIso
    });
    if (summary.recovery.halted) {
      summary.halted = true;
      summary.haltReason = summary.recovery.haltReason;
      return summary;
    }

    if (haltReason) {
      summary.halted = true;
      summary.haltReason = haltReason;
      return summary;
    }

    const runLivePhase = async (): Promise<{ halt: boolean; haltReason: string | null }> => {
      const phaseNowIso = new Date().toISOString();
      if (await args.killSwitchActive()) {
        haltLiveTrading(args.db, "KILL_SWITCH", {}, phaseNowIso);
        return { halt: true, haltReason: "KILL_SWITCH" };
      }

      const existingHalt = readLiveHaltReason(args.db);
      if (existingHalt) {
        return { halt: true, haltReason: existingHalt };
      }

      const recovery = await runOrderRecoveryCycle(args.db, {
        clob: args.clob,
        rpc: args.rpc,
        owner: args.owner,
        funder: args.funder,
        signatureType: args.signatureType,
        encryptionKey: args.encryptionKey,
        maxRecoveryAttempts: args.config.runtime.maxRecoveryAttempts,
        breakerThresholds,
        signBoundary: signBoundaryConfigFromRiskAndMarket(args.config.risk, args.config.market),
        killSwitchActive: args.killSwitchActive,
        nowIso: phaseNowIso
      });
      summary.recovery = mergeRecovery(summary.recovery, recovery);
      if (recovery.halted) {
        return { halt: true, haltReason: recovery.haltReason };
      }

      const cycle = await runLiveTradingCycle(args.db, {
        clob: args.clob,
        signer: args.signer,
        rpc: args.rpc,
        owner: args.owner,
        funder: args.funder,
        signatureType: args.signatureType,
        encryptionKey: args.encryptionKey,
        maxPendingSubmissions: args.config.runtime.maxPendingSubmissions,
        maxOneLiveOrder: args.config.live.maxOneLiveOrder,
        balanceMismatchToleranceRaw: args.config.market.balanceMismatchToleranceRaw,
        maxPositionAgeMs: args.config.market.maxPositionAgeMs,
        leaders: args.leaders,
        clobCacheMaxAgeMs: args.config.market.clobCacheMaxAgeMs,
        signBoundary: signBoundaryConfigFromRiskAndMarket(args.config.risk, args.config.market),
        killSwitchActive: args.killSwitchActive
      });
      summary.liveCycles.push(cycle);

      const breaker = evaluateLiveCycleBreakers(
        args.db,
        breakerThresholds,
        {
          rejected: cycle.rejected,
          timeoutUnknown: cycle.timeoutUnknown,
          staleAtSign: cycle.staleAtSign,
          bookSourceMismatch: cycle.bookSourceMismatch,
          clobUnavailable: cycle.clobUnavailable,
          cacheMismatch: cycle.cacheMismatch,
          reconciled: cycle.reconciled + recovery.reconciled,
          recoveryTerminal: recovery.terminal
        },
        phaseNowIso
      );
      if (breaker.halted) {
        return { halt: true, haltReason: breaker.haltReason };
      }
      if (cycle.halted) {
        return { halt: true, haltReason: cycle.haltReason };
      }
      return { halt: false, haltReason: null };
    };

    if (args.skipIngestion) {
      const maxCycles = Math.max(1, args.maxLiveCycles ?? 1);
      for (let cycle = 0; cycle < maxCycles; cycle += 1) {
        const phase = await runLivePhase();
        if (phase.halt) {
          halted = true;
          haltReason = phase.haltReason;
          break;
        }
        if (cycle + 1 < maxCycles && args.pollMs > 0) {
          await sleep(args.pollMs);
        }
      }
    } else {
      const receiptVerificationRpc =
        args.receiptVerificationRpc ??
        (args.receiptVerificationRpcUrl ? createHttpRpcAdapter(args.receiptVerificationRpcUrl) : undefined);
      summary.ingestion = await runIngestionLoop({
        rpcUrl: args.rpcUrl,
        wsUrl: args.wsUrl ?? resolveWsUrl({ rpcUrl: args.rpcUrl }),
        leaders: args.leaders,
        config: args.config,
        dbPath: args.config.runtime.dbPath,
        logPath: args.logPath,
        durationMs: args.durationMs,
        lookbackBlocks: args.lookbackBlocks,
        confirmationDepth: args.config.runtime.confirmationDepth,
        aggregationWindowBlocks: args.config.runtime.aggregationWindowBlocks,
        reorgLookbackBlocks: args.config.runtime.reorgLookbackBlocks,
        confirmedLogMaxDelayMs: args.config.runtime.confirmedLogMaxDelayMs,
        polygonBlockTimeMs: args.config.runtime.polygonBlockTimeMs,
        risk: args.risk,
        enableSell: args.enableSell,
        pollMs: args.pollMs,
        useWebSocket: args.useWebSocket,
        db: args.db,
        receiptVerificationRpc,
        resolveMetadata: (tokenId) => args.clob.getMarket(tokenId),
        onAfterCommit: async () => {
          const phase = await runLivePhase();
          if (phase.halt) {
            halted = true;
            haltReason = phase.haltReason;
            await writeJsonl(args.logPath, {
              event: "live_halted",
              reason: phase.haltReason
            });
          }
          return { halt: phase.halt };
        },
        shouldHalt: () => halted || Boolean(readLiveHaltReason(args.db))
      });
    }

    summary.halted = halted || Boolean(readLiveHaltReason(args.db));
    summary.haltReason = haltReason ?? readLiveHaltReason(args.db);
    return summary;
  } finally {
    await releaseLock();
  }
}

function mergeRecovery(
  current: OrderRecoveryCycleResult | null,
  next: OrderRecoveryCycleResult
): OrderRecoveryCycleResult {
  if (!current) return next;
  return {
    startup: {
      createdCancelled: current.startup.createdCancelled + next.startup.createdCancelled,
      createdResumed: current.startup.createdResumed + next.startup.createdResumed,
      submittingRecovered: current.startup.submittingRecovered + next.startup.submittingRecovered,
      partialReconciled: current.startup.partialReconciled + next.startup.partialReconciled,
      filledVerified: current.startup.filledVerified + next.startup.filledVerified
    },
    reconciled: current.reconciled + next.reconciled,
    retried: current.retried + next.retried,
    terminal: current.terminal + next.terminal,
    uncertain: current.uncertain + next.uncertain,
    halted: next.halted,
    haltReason: next.haltReason
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function ingestionRiskFromConfig(config: Config): IngestionRiskConfig {
  return {
    copyPct: config.risk.copyPct,
    maxTradePusdRaw: config.risk.maxTradePusdRaw ?? "1000000",
    maxDailySpendPusdRaw: config.risk.maxDailySpendPusdRaw ?? "5000000",
    maxMarketPositionPusdRaw: config.risk.maxMarketPositionPusdRaw ?? "5000000",
    freeBudgetPusdRaw: config.risk.freeBudgetPusdRaw ?? "5000000",
    maxTradesPerDay: config.risk.maxTradesPerDay ?? 5,
    maxTradeFractionOfBudgetBps: config.risk.maxTradeFractionOfBudgetBps,
    maxBuyPpm: config.risk.maxBuyPpm,
    minSellPpm: config.risk.minSellPpm,
    maxSpreadPpm: config.risk.maxSpreadPpm,
    maxDriftPpm: config.risk.maxDriftPpm,
    maxBookParticipationBps: config.risk.maxBookParticipationBps,
    slippageCapPpm: config.risk.slippageCapPpm
  };
}

export function summarizeUnifiedLive(summary: UnifiedLiveSummary): Record<string, unknown> {
  const live = summary.liveCycles.reduce(
    (totals, cycle) => ({
      considered: totals.considered + cycle.considered,
      outboxed: totals.outboxed + cycle.outboxed,
      submitted: totals.submitted + cycle.submitted,
      reconciled: totals.reconciled + cycle.reconciled,
      rejected: totals.rejected + cycle.rejected,
      timeoutUnknown: totals.timeoutUnknown + cycle.timeoutUnknown,
      staleAtSign: totals.staleAtSign + cycle.staleAtSign,
      cacheMismatch: totals.cacheMismatch + cycle.cacheMismatch,
      skipped: totals.skipped + cycle.skipped,
      errors: totals.errors + cycle.errors,
      halted: totals.halted || cycle.halted,
      haltReason: cycle.haltReason ?? totals.haltReason
    }),
    {
      considered: 0,
      outboxed: 0,
      submitted: 0,
      reconciled: 0,
      rejected: 0,
      timeoutUnknown: 0,
      staleAtSign: 0,
      cacheMismatch: 0,
      skipped: 0,
      errors: 0,
      halted: false,
      haltReason: null as string | null
    }
  );

  return {
    mode: summary.mode,
    cycles: summary.liveCycles.length,
    ingestion: summary.ingestion
      ? {
          decisions: summary.ingestion.decisions,
          approved: summary.ingestion.approved,
          skipped: summary.ingestion.skipped,
          iterations: summary.ingestion.iterations,
          transport: summary.ingestion.transport
        }
      : null,
    recovery: summary.recovery,
    ...live,
    halted: summary.halted || live.halted,
    haltReason: summary.haltReason ?? live.haltReason
  };
}
