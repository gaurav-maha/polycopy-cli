import type { IngestionRiskConfig } from "../ingestion/runner.js";

export const CONSERVATIVE_RISK: IngestionRiskConfig = {
  copyPct: "0.10",
  maxTradePusdRaw: "1000000",
  maxDailySpendPusdRaw: "5000000",
  maxMarketPositionPusdRaw: "5000000",
  freeBudgetPusdRaw: "5000000",
  maxTradesPerDay: 5,
  maxTradeFractionOfBudgetBps: 2000,
  maxBuyPpm: 980_000,
  minSellPpm: 20_000,
  maxSpreadPpm: 80_000,
  maxDriftPpm: 30_000,
  maxBookParticipationBps: 1500,
  slippageCapPpm: 50_000
};

export function conservativeRiskWithCopyPct(copyPct: string): IngestionRiskConfig {
  return { ...CONSERVATIVE_RISK, copyPct };
}
