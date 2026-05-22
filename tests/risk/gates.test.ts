import { evaluateDryRunDecision } from "../../src/risk/gates.js";
import type { MarketMetadata } from "../../src/adapters/types.js";

const baseGroup = {
  id: "ag_1",
  chainId: 137 as const,
  contractAddress: "0xE111180000d2663C0091e4f400237545B87B996B" as const,
  sourceWallet: "0x9d84cE0306F8551e02EFef1680475Fc0f1dC1344" as const,
  tokenId: "123",
  side: "BUY" as const,
  windowStartBlock: 100,
  windowEndBlock: 102,
  reorgGeneration: 0,
  sourceFillIds: ["sf_1"],
  leaderPricePpm: "500000",
  leaderNotionalRaw: "1000000",
  leaderBudgetImpactRaw: "1000000",
  tokenDeltaRaw: "2000000",
  inventoryDeltaRaw: "0",
  feeRaw: "0"
};

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
    maxBookParticipationBps: 1500
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

describe("cheap-first risk gates", () => {
  it("skips SELL before inventory/book gates when copy.enableSell=false", async () => {
    let bookFetches = 0;
    const decision = await evaluateDryRunDecision(
      { ...baseGroup, side: "SELL", leaderPricePpm: "500000", inventoryDeltaRaw: "1000000", tokenDeltaRaw: "0" },
      {
        ...baseConfig,
        nowMs: 1_000_000,
        sourceBlockTimestampMs: 990_000,
        fetchBook: async () => {
          bookFetches += 1;
          throw new Error("must not fetch");
        }
      }
    );

    expect(decision.status).toBe("SKIPPED");
    expect(decision.skipReason).toBe("SIDE_DISABLED");
    expect(bookFetches).toBe(0);
  });

  it("skips BUY price cap before book fetch with a precise reason", async () => {
    let bookFetches = 0;
    const decision = await evaluateDryRunDecision(
      { ...baseGroup, leaderPricePpm: "990000" },
      {
        ...baseConfig,
        nowMs: 1_000_000,
        sourceBlockTimestampMs: 990_000,
        fetchBook: async () => {
          bookFetches += 1;
          throw new Error("must not fetch");
        }
      }
    );

    expect(decision.status).toBe("SKIPPED");
    expect(decision.skipReason).toBe("PRICE_ABOVE_MAX_BUY");
    expect(bookFetches).toBe(0);
  });

  it("keeps DRIFT_BUY for a live book price that has moved above the leader price", async () => {
    const decision = await evaluateDryRunDecision(baseGroup, {
      ...baseConfig,
      nowMs: 1_000_000,
      sourceBlockTimestampMs: 990_000,
      fetchBook: async () => ({
        spreadPpm: 10_000,
        vwapPpm: 540_001,
        visibleDepthRaw: "5000000",
        intendedSizeRaw: "2000000",
        bookSource: "REST",
        wsAgeMs: Number.POSITIVE_INFINITY,
        restAgeMs: 0,
        restCrossCheckPpm: 540_001,
        restCrossCheckAgeMs: 0
      })
    });

    expect(decision.status).toBe("SKIPPED");
    expect(decision.skipReason).toBe("DRIFT_BUY");
  });

  it("approves a dry-run BUY after book walk passes", async () => {
    const decision = await evaluateDryRunDecision(baseGroup, {
      ...baseConfig,
      nowMs: 1_000_000,
      sourceBlockTimestampMs: 990_000,
      fetchBook: async () => ({
        spreadPpm: 10_000,
        vwapPpm: 505_000,
        visibleDepthRaw: "5000000",
        intendedSizeRaw: "2000000",
        bookSource: "REST",
        wsAgeMs: Number.POSITIVE_INFINITY,
        restAgeMs: 0,
        restCrossCheckPpm: 505_000,
        restCrossCheckAgeMs: 0
      })
    });

    expect(decision).toMatchObject({
      status: "ACTIVE",
      skipReason: null,
      intendedCopyNotionalRaw: "100000",
      approvedCopyNotionalRaw: "100000"
    });
  });

  it("rounds approved BUY notional down to the SDK market-order granularity", async () => {
    const decision = await evaluateDryRunDecision(
      { ...baseGroup, leaderPricePpm: "13000", leaderNotionalRaw: "3650400" },
      {
        ...baseConfig,
        nowMs: 1_000_000,
        sourceBlockTimestampMs: 990_000,
        fetchBook: async () => ({
          spreadPpm: 4_000,
          vwapPpm: 18_000,
          visibleDepthRaw: "184799494150",
          intendedSizeRaw: "20280000",
          bookSource: "REST",
          wsAgeMs: Number.POSITIVE_INFINITY,
          restAgeMs: 0,
          restCrossCheckPpm: 18_000,
          restCrossCheckAgeMs: 0
        })
      }
    );

    expect(decision).toMatchObject({
      status: "ACTIVE",
      skipReason: null,
      intendedCopyNotionalRaw: "365040",
      approvedCopyNotionalRaw: "360000"
    });
    expect(decision.gateSnapshot.sdkAmountRounding).toEqual({
      rawBefore: "365040",
      rawAfter: "360000",
      quantumRaw: "10000"
    });
  });

  it("skips a BUY when the configured budget covers notional but not fee headroom", async () => {
    const decision = await evaluateDryRunDecision(
      { ...baseGroup, leaderPricePpm: "290000", leaderNotionalRaw: "9988248" },
      {
        ...baseConfig,
        risk: {
          ...baseConfig.risk,
          copyPct: "1.0",
          maxTradePusdRaw: "9988248",
          maxDailySpendPusdRaw: "9988248",
          maxMarketPositionPusdRaw: "9988248",
          freeBudgetPusdRaw: "9988248",
          maxTradeFractionOfBudgetBps: 10000
        },
        nowMs: 1_000_000,
        sourceBlockTimestampMs: 990_000,
        resolveMetadata: async () => paidMarketMetadata(),
        fetchBook: async () => ({
          spreadPpm: 0,
          vwapPpm: 290_000,
          visibleDepthRaw: "998824800",
          intendedSizeRaw: "34442234",
          bookSource: "REST",
          wsAgeMs: Number.POSITIVE_INFINITY,
          restAgeMs: 0,
          restCrossCheckPpm: 290_000,
          restCrossCheckAgeMs: 0
        })
      }
    );

    expect(decision).toMatchObject({
      status: "SKIPPED",
      skipReason: "BUDGET",
      intendedCopyNotionalRaw: "9988248"
    });
    expect(decision.gateSnapshot).toMatchObject({
      feeHeadroomRaw: "461076",
      totalBuyRequiredRaw: "10441076"
    });
  });

  it("approves a dry-run SELL when inventory and book pass", async () => {
    const decision = await evaluateDryRunDecision(
      { ...baseGroup, side: "SELL", leaderPricePpm: "500000", inventoryDeltaRaw: "1000000", tokenDeltaRaw: "0" },
      {
        ...baseConfig,
        copy: { enableSell: true },
        inventory: {
          sharesRaw: "1000000",
          activeSellReservedSharesRaw: "0",
          lastReconciledAtMs: 1_000_000
        },
        nowMs: 1_000_000,
        sourceBlockTimestampMs: 990_000,
        fetchBook: async () => ({
          spreadPpm: 10_000,
          vwapPpm: 495_000,
          visibleDepthRaw: "5000000",
          intendedSizeRaw: "200000",
          bookSource: "REST",
          wsAgeMs: Number.POSITIVE_INFINITY,
          restAgeMs: 0,
          restCrossCheckPpm: 495_000,
          restCrossCheckAgeMs: 0
        })
      }
    );

    expect(decision).toMatchObject({
      status: "ACTIVE",
      skipReason: null,
      intendedCopyNotionalRaw: "100000",
      approvedCopyNotionalRaw: "100000"
    });
  });
});

function paidMarketMetadata(): MarketMetadata {
  return {
    tokenId: "123",
    source: "REST",
    receivedAtMs: 1_000_000,
    conditionId: `0x${"a".repeat(64)}`,
    outcome: "YES",
    negRisk: false,
    active: true,
    resolved: false,
    paused: false,
    tickSize: "0.01",
    tickSizePpm: 10_000,
    minOrderSizeSharesDecimal: "0.000001",
    feeConfig: {
      r: "0.07",
      e: "1",
      to: "0x0000000000000000000000000000000000000000",
      raw: { fixture: true }
    }
  };
}
