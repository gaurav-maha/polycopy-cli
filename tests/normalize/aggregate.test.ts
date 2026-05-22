import { aggregateFills, computeAggregationGroupId, type FillWithId } from "../../src/normalize/aggregate.js";
import { CTF_EXCHANGE_V2 } from "../../src/constants/chain.js";

function fill(overrides: Partial<FillWithId> & { id: string; blockNumber: bigint }): FillWithId {
  return {
    id: overrides.id,
    chainId: 137,
    contractAddress: CTF_EXCHANGE_V2,
    blockNumber: overrides.blockNumber,
    blockHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    txHash: overrides.txHash ?? "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    txIndex: 0,
    logIndex: 0,
    orderHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
    maker: "0x9d84cE0306F8551e02EFef1680475Fc0f1dC1344",
    taker: CTF_EXCHANGE_V2,
    side: overrides.side ?? "BUY",
    tokenId: overrides.tokenId ?? "123",
    makerAmountFilledRaw: overrides.makerAmountFilledRaw ?? "100",
    takerAmountFilledRaw: overrides.takerAmountFilledRaw ?? "200",
    feeRaw: overrides.feeRaw ?? "0",
    builder: "0x0000000000000000000000000000000000000000000000000000000000000000",
    metadata: "0x0000000000000000000000000000000000000000000000000000000000000000",
    pricePpm: overrides.pricePpm ?? "500000"
  };
}

describe("source fill aggregation", () => {
  it("merges eligible fills in the cross-block window and computes BUY weighted PPM", () => {
    const groups = aggregateFills(
      [
        fill({ id: "a", blockNumber: 10n, makerAmountFilledRaw: "100", takerAmountFilledRaw: "400", feeRaw: "1" }),
        fill({ id: "b", blockNumber: 12n, txHash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", makerAmountFilledRaw: "300", takerAmountFilledRaw: "600", feeRaw: "2" }),
        fill({ id: "c", blockNumber: 13n, txHash: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd", makerAmountFilledRaw: "100", takerAmountFilledRaw: "100" })
      ],
      {
        aggregationWindowBlocks: 2,
        reorgGeneration: 0
      }
    );

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      sourceFillIds: ["a", "b"],
      windowStartBlock: 10,
      windowEndBlock: 12,
      leaderPricePpm: "400000",
      leaderNotionalRaw: "400",
      leaderBudgetImpactRaw: "403",
      tokenDeltaRaw: "1000"
    });
  });

  it("computes SELL weighted PPM with side-specific denominator", () => {
    const [group] = aggregateFills(
      [
        fill({ id: "a", blockNumber: 10n, side: "SELL", makerAmountFilledRaw: "500", takerAmountFilledRaw: "200" }),
        fill({ id: "b", blockNumber: 10n, side: "SELL", makerAmountFilledRaw: "500", takerAmountFilledRaw: "300" })
      ],
      {
        aggregationWindowBlocks: 2,
        reorgGeneration: 0
      }
    );

    expect(group?.leaderPricePpm).toBe("500000");
    expect(group?.leaderNotionalRaw).toBe("500");
    expect(group?.inventoryDeltaRaw).toBe("1000");
  });

  it("aggregates leader-taker normalized fills with leader source wallet and inverted side", () => {
    const [group] = aggregateFills(
      [
        fill({
          id: "a",
          blockNumber: 10n,
          maker: "0x1111111111111111111111111111111111111111",
          taker: "0x9d84cE0306F8551e02EFef1680475Fc0f1dC1344",
          sourceWallet: "0x9d84cE0306F8551e02EFef1680475Fc0f1dC1344",
          side: "BUY",
          makerAmountFilledRaw: "400",
          takerAmountFilledRaw: "1000",
          feeRaw: "0",
          filledNotionalRaw: "400",
          budgetImpactRaw: "400",
          tokenDeltaRaw: "1000"
        })
      ],
      {
        aggregationWindowBlocks: 2,
        reorgGeneration: 0
      }
    );

    expect(group).toMatchObject({
      sourceWallet: "0x9d84cE0306F8551e02EFef1680475Fc0f1dC1344",
      side: "BUY",
      leaderPricePpm: "400000",
      leaderNotionalRaw: "400",
      leaderBudgetImpactRaw: "400",
      tokenDeltaRaw: "1000",
      inventoryDeltaRaw: "0"
    });
  });

  it("uses deterministic group ids including reorg generation and first fill identity", () => {
    const one = computeAggregationGroupId({
      chainId: 137,
      contractAddress: CTF_EXCHANGE_V2,
      sourceWallet: "0x9d84cE0306F8551e02EFef1680475Fc0f1dC1344",
      tokenId: "123",
      side: "BUY",
      windowStartBlock: 10,
      reorgGeneration: 0,
      firstSourceFillId: "a"
    });
    const two = computeAggregationGroupId({
      chainId: 137,
      contractAddress: CTF_EXCHANGE_V2,
      sourceWallet: "0x9d84cE0306F8551e02EFef1680475Fc0f1dC1344",
      tokenId: "123",
      side: "BUY",
      windowStartBlock: 10,
      reorgGeneration: 1,
      firstSourceFillId: "a"
    });
    expect(one).toMatch(/^ag_[a-f0-9]{64}$/);
    expect(one).not.toBe(two);
  });
});
