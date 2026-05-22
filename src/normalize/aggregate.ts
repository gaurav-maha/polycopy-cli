import { createHash } from "node:crypto";
import { getAddress } from "viem";
import { DecodedOrderFilled } from "../protocol/decode-order-filled.js";
import { deriveEconomics } from "./side-math.js";

export type FillWithId = DecodedOrderFilled & {
  id: string;
  sourceWallet?: `0x${string}`;
  filledNotionalRaw?: string;
  budgetImpactRaw?: string;
  tokenDeltaRaw?: string;
  inventoryDeltaRaw?: string;
};

export type AggregationGroup = {
  id: string;
  chainId: 137;
  contractAddress: `0x${string}`;
  sourceWallet: `0x${string}`;
  tokenId: string;
  side: "BUY" | "SELL";
  windowStartBlock: number;
  windowEndBlock: number;
  reorgGeneration: number;
  sourceFillIds: string[];
  leaderPricePpm: string;
  leaderNotionalRaw: string;
  leaderBudgetImpactRaw: string;
  tokenDeltaRaw: string;
  inventoryDeltaRaw: string;
  feeRaw: string;
};

export function computeAggregationGroupId(args: {
  chainId: 137;
  contractAddress: `0x${string}`;
  sourceWallet: `0x${string}`;
  tokenId: string;
  side: "BUY" | "SELL";
  windowStartBlock: number;
  reorgGeneration: number;
  firstSourceFillId: string;
}): string {
  const normalized = [
    args.chainId,
    getAddress(args.contractAddress).toLowerCase(),
    getAddress(args.sourceWallet).toLowerCase(),
    args.tokenId,
    args.side,
    args.windowStartBlock,
    args.reorgGeneration,
    args.firstSourceFillId
  ].join("|");
  return `ag_${createHash("sha256").update(normalized).digest("hex")}`;
}

function recompute(group: AggregationGroup, fills: FillWithId[]): AggregationGroup {
  const notionalSum = fills.reduce((sum, fill) => sum + BigInt(fillEconomics(fill).filledNotionalRaw), 0n);
  const tokenDeltaSum = fills.reduce((sum, fill) => sum + BigInt(fillEconomics(fill).tokenDeltaRaw ?? "0"), 0n);
  const inventoryDeltaSum = fills.reduce((sum, fill) => sum + BigInt(fillEconomics(fill).inventoryDeltaRaw ?? "0"), 0n);
  const shareSum = tokenDeltaSum + inventoryDeltaSum;
  const budgetImpactSum = fills.reduce((sum, fill) => sum + BigInt(fillEconomics(fill).budgetImpactRaw), 0n);
  const feeSum = fills.reduce((sum, fill) => sum + BigInt(fill.feeRaw), 0n);
  if (notionalSum <= 0n || shareSum <= 0n) {
    throw new Error("aggregation requires nonzero filled amounts");
  }
  const leaderPricePpm = (notionalSum * 1_000_000n) / shareSum;
  return {
    ...group,
    leaderPricePpm: leaderPricePpm.toString(),
    leaderNotionalRaw: notionalSum.toString(),
    leaderBudgetImpactRaw: budgetImpactSum.toString(),
    tokenDeltaRaw: tokenDeltaSum.toString(),
    inventoryDeltaRaw: inventoryDeltaSum.toString(),
    feeRaw: feeSum.toString()
  };
}

function fillEconomics(fill: FillWithId): {
  filledNotionalRaw: string;
  budgetImpactRaw: string;
  tokenDeltaRaw?: string;
  inventoryDeltaRaw?: string;
} {
  if (fill.filledNotionalRaw && fill.budgetImpactRaw) {
    return {
      filledNotionalRaw: fill.filledNotionalRaw,
      budgetImpactRaw: fill.budgetImpactRaw,
      tokenDeltaRaw: fill.tokenDeltaRaw,
      inventoryDeltaRaw: fill.inventoryDeltaRaw
    };
  }
  return deriveEconomics(fill);
}

function fillSourceWallet(fill: FillWithId): `0x${string}` {
  return getAddress(fill.sourceWallet ?? fill.maker) as `0x${string}`;
}

export function sortAggregationGroupsForDecision(groups: AggregationGroup[]): AggregationGroup[] {
  return [...groups].sort((a, b) => {
    if (a.windowEndBlock !== b.windowEndBlock) return a.windowEndBlock - b.windowEndBlock;
    if (a.windowStartBlock !== b.windowStartBlock) return a.windowStartBlock - b.windowStartBlock;
    const walletDelta = a.sourceWallet.toLowerCase().localeCompare(b.sourceWallet.toLowerCase());
    if (walletDelta !== 0) return walletDelta;
    const tokenDelta = a.tokenId.localeCompare(b.tokenId);
    if (tokenDelta !== 0) return tokenDelta;
    return a.side.localeCompare(b.side);
  });
}

export function aggregateFills(
  fills: FillWithId[],
  args: { aggregationWindowBlocks: number; reorgGeneration: number }
): AggregationGroup[] {
  const sorted = [...fills].sort((a, b) => {
    const blockDelta = Number(a.blockNumber) - Number(b.blockNumber);
    if (blockDelta !== 0) return blockDelta;
    if (a.txIndex !== b.txIndex) return a.txIndex - b.txIndex;
    return a.logIndex - b.logIndex;
  });

  const groups: Array<{ group: AggregationGroup; fills: FillWithId[] }> = [];
  for (const fill of sorted) {
    const sourceWallet = fillSourceWallet(fill);
    const existing = groups.find(({ group }) => {
      return (
        group.chainId === fill.chainId &&
        getAddress(group.contractAddress).toLowerCase() === getAddress(fill.contractAddress).toLowerCase() &&
        getAddress(group.sourceWallet).toLowerCase() === sourceWallet.toLowerCase() &&
        group.tokenId === fill.tokenId &&
        group.side === fill.side &&
        Number(fill.blockNumber) <= group.windowEndBlock
      );
    });

    if (existing) {
      existing.group.sourceFillIds.push(fill.id);
      existing.fills.push(fill);
      existing.group = recompute(existing.group, existing.fills);
      continue;
    }

    const windowStartBlock = Number(fill.blockNumber);
    const group: AggregationGroup = {
      id: computeAggregationGroupId({
        chainId: fill.chainId,
        contractAddress: fill.contractAddress,
        sourceWallet,
        tokenId: fill.tokenId,
        side: fill.side,
        windowStartBlock,
        reorgGeneration: args.reorgGeneration,
        firstSourceFillId: fill.id
      }),
      chainId: fill.chainId,
      contractAddress: fill.contractAddress,
      sourceWallet,
      tokenId: fill.tokenId,
      side: fill.side,
      windowStartBlock,
      windowEndBlock: windowStartBlock + args.aggregationWindowBlocks,
      reorgGeneration: args.reorgGeneration,
      sourceFillIds: [fill.id],
      leaderPricePpm: "0",
      leaderNotionalRaw: "0",
      leaderBudgetImpactRaw: "0",
      tokenDeltaRaw: "0",
      inventoryDeltaRaw: "0",
      feeRaw: "0"
    };
    groups.push({ group: recompute(group, [fill]), fills: [fill] });
  }
  return groups.map(({ group }) => group);
}
