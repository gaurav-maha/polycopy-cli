import { runIngestionLoop, type IngestionRiskConfig, type IngestionRunnerArgs, type IngestionSummary } from "../ingestion/runner.js";
import type { Config } from "../config/schema.js";
import { fetchPublicClobMarketMetadata } from "./book.js";

export type LiveDataDryRunArgs = {
  rpcUrl: string;
  wsUrl?: string;
  leaders: `0x${string}`[];
  config?: Config;
  dbPath: string;
  logPath: string;
  durationMs: number;
  pollMs: number;
  lookbackBlocks: bigint;
  confirmationDepth: bigint;
  aggregationWindowBlocks: number;
  reorgLookbackBlocks: number;
  confirmedLogMaxDelayMs: number;
  polygonBlockTimeMs: number;
  risk: IngestionRiskConfig;
  enableSell: boolean;
  maxIterations?: number;
  useWebSocket?: boolean;
};

export type LiveDataDryRunSummary = IngestionSummary;

export async function runLiveDataDryRun(args: LiveDataDryRunArgs): Promise<LiveDataDryRunSummary> {
  const runnerArgs: IngestionRunnerArgs = {
    rpcUrl: args.rpcUrl,
    wsUrl: args.wsUrl,
    leaders: args.leaders,
    config: args.config,
    dbPath: args.dbPath,
    logPath: args.logPath,
    durationMs: args.durationMs,
    lookbackBlocks: args.lookbackBlocks,
    confirmationDepth: Number(args.confirmationDepth),
    aggregationWindowBlocks: args.aggregationWindowBlocks,
    reorgLookbackBlocks: args.reorgLookbackBlocks,
    confirmedLogMaxDelayMs: args.confirmedLogMaxDelayMs,
    polygonBlockTimeMs: args.polygonBlockTimeMs,
    risk: args.risk,
    enableSell: args.enableSell,
    pollMs: args.pollMs,
    maxIterations: args.maxIterations,
    useWebSocket: args.useWebSocket,
    resolveMetadata: fetchPublicClobMarketMetadata
  };
  return runIngestionLoop(runnerArgs);
}
