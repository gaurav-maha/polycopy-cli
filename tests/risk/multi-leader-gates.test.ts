import { describe, expect, it } from "vitest";
import { evaluateDryRunDecision } from "../../src/risk/gates.js";
import { createDecisionBatchState } from "../../src/risk/leader-budgets.js";
import type { Config } from "../../src/config/schema.js";
import { sortAggregationGroupsForDecision, type AggregationGroup } from "../../src/normalize/aggregate.js";

const leaderA = "0x9d84cE0306F8551e02EFef1680475Fc0f1dC1344" as const;
const leaderB = "0x1111111111111111111111111111111111111111" as const;

function makeGroup(overrides: Partial<AggregationGroup>): AggregationGroup {
  return {
    id: overrides.id ?? "ag_1",
    chainId: 137,
    contractAddress: "0xE111180000d2663C0091e4f400237545B87B996B" as const,
    sourceWallet: leaderA,
    tokenId: "123",
    side: "BUY",
    windowStartBlock: 100,
    windowEndBlock: 102,
    reorgGeneration: 0,
    sourceFillIds: ["sf_1"],
    leaderPricePpm: "500000",
    leaderNotionalRaw: "1000000",
    leaderBudgetImpactRaw: "1000000",
    tokenDeltaRaw: "2000000",
    inventoryDeltaRaw: "0",
    feeRaw: "0",
    ...overrides
  };
}

const baseConfig = {
  copy: { enableSell: false },
  risk: {
    copyPct: "0.10",
    maxTradePusdRaw: "1000000",
    maxDailySpendPusdRaw: "1000000",
    maxMarketPositionPusdRaw: "1000000",
    freeBudgetPusdRaw: "1000000",
    maxTradesPerDay: 10,
    maxTradeFractionOfBudgetBps: 5000,
	    maxBuyPpm: 980000,
	    minSellPpm: 20000,
	    maxSpreadPpm: 80000,
	    maxDriftPpm: 30000,
	    slippageCapPpm: 50_000,
	    maxBookParticipationBps: 1500,
	    consecutiveRejectionsHalt: 5,
	    consecutiveTimeoutUnknownHalt: 3,
	    staleBookHalt: 5,
	    bookSourceMismatchHalt: 3,
	    clobUnavailableHalt: 3
	  },
  runtime: {
    confirmationDepth: 2,
    confirmedLogMaxDelayMs: 120_000,
    polygonBlockTimeMs: 2_000
  },
  market: {
    metadataMaxAgeMs: 60_000,
    maxPositionAgeMs: 300_000,
    clobCacheMaxAgeMs: 60_000,
    onchainBalanceMaxAgeMs: 120_000,
    balanceMismatchToleranceRaw: "0"
  }
};

const bookResult = {
  spreadPpm: 10_000,
  vwapPpm: 505_000,
  visibleDepthRaw: "5000000",
  intendedSizeRaw: "2000000",
  bookSource: "REST" as const,
  wsAgeMs: Number.POSITIVE_INFINITY,
  restAgeMs: 0,
  restCrossCheckPpm: 505_000,
  restCrossCheckAgeMs: 0
};

const appConfig = {
  chainId: 137 as const,
  sourceWallets: [leaderA, leaderB],
  leaders: {
    [leaderA]: { maxDailySpendPusdRaw: "500000" },
    [leaderB]: { maxDailySpendPusdRaw: "1000000" }
  },
  rpcProviders: [],
  account: {
    walletMode: "EOA" as const,
    signatureType: 0 as const
  },
  copy: { enableSell: false },
  risk: baseConfig.risk,
  runtime: {
    dataDir: "./.polycopy",
    dbPath: "./.polycopy/polycopy.db",
    logDir: "./.polycopy/logs",
    killSwitchPath: "./.polycopy/kill.switch",
    lockPath: "./.polycopy/polycopy.lock",
	    confirmationDepth: 2,
    aggregationWindowBlocks: 2,
    confirmedLogMaxDelayMs: 120_000,
    polygonBlockTimeMs: 2_000,
    reorgLookbackBlocks: 64,
    maxRecoveryAttempts: 5,
    maxPendingSubmissions: 32,
    clockSkewMaxMs: 3_000
  },
  market: {
    ...baseConfig.market,
    metadataRestCrossCheckMaxAgeMs: 300_000,
    bookRestCrossCheckMaxAgeMs: 1_500,
    maxBookAgeMs: 800,
    wsStaleMs: 500,
    restStaleMs: 1_500,
    bookMismatchPpm: 100_000,
    clobCacheMaxAgeMs: 60_000,
    orderTypeFOKForFullSize: false
  },
  live: {
    enabled: false,
    maxOneLiveOrder: true,
    ciTinyBudgetPusdRaw: "5000000"
  }
} satisfies Config;

describe("multi-leader contention gates", () => {
  it("sorts ready groups deterministically before decision evaluation", () => {
    const sorted = sortAggregationGroupsForDecision([
      makeGroup({ id: "ag_b", sourceWallet: leaderB, windowStartBlock: 100, tokenId: "999" }),
      makeGroup({ id: "ag_a", sourceWallet: leaderA, windowStartBlock: 100, tokenId: "123" })
    ]);
    expect(sorted.map((group) => group.id)).toEqual(["ag_b", "ag_a"]);
  });

  it("skips second leader on same token with TOKEN contention", async () => {
    const batch = createDecisionBatchState({ nowMs: 1_000_000 });
    const shared = {
      ...baseConfig,
      config: appConfig,
      batch,
      nowMs: 1_000_000,
      sourceBlockTimestampMs: 990_000,
      fetchBook: async () => bookResult
    };

    const first = await evaluateDryRunDecision(makeGroup({ id: "ag_a", sourceWallet: leaderA }), shared);
    const second = await evaluateDryRunDecision(
      makeGroup({ id: "ag_b", sourceWallet: leaderB, sourceFillIds: ["sf_2"] }),
      shared
    );

    expect(first.status).toBe("ACTIVE");
    expect(second.status).toBe("SKIPPED");
    expect(second.skipReason).toBe("BUDGET");
    expect(second.gateSnapshot.contentionKind).toBe("TOKEN");
  });

  it("skips leader A when per-leader daily cap is exhausted", async () => {
    const batch = createDecisionBatchState({
      nowMs: 1_000_000,
      leaderDaily: new Map([
        [
          leaderA.toLowerCase(),
          { realizedSpendPusdRaw: 500_000n, reservedSpendPusdRaw: 0n, tradeCount: 5 }
        ]
      ])
    });

    const decision = await evaluateDryRunDecision(makeGroup({ sourceWallet: leaderA, tokenId: "456" }), {
      ...baseConfig,
      config: appConfig,
      batch,
      nowMs: 1_000_000,
      sourceBlockTimestampMs: 990_000,
      fetchBook: async () => bookResult
    });

    expect(decision.status).toBe("SKIPPED");
    expect(decision.skipReason).toBe("DAILY_CAP");
    expect(decision.gateSnapshot.contentionKind).toBe("LEADER");
  });
});
