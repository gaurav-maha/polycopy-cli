import { DecodedOrderFilled } from "../protocol/decode-order-filled.js";

export type LeaderRole = "MAKER" | "TAKER";

export type NormalizedEconomics = {
  side: "BUY" | "SELL";
  feeRaw: string;
  filledNotionalRaw: string;
  budgetImpactRaw: string;
  proceedsRaw?: string;
  tokenDeltaRaw?: string;
  inventoryDeltaRaw?: string;
};

function deriveMakerEconomics(fill: DecodedOrderFilled): NormalizedEconomics {
  const maker = BigInt(fill.makerAmountFilledRaw);
  const taker = BigInt(fill.takerAmountFilledRaw);
  const fee = BigInt(fill.feeRaw);
  if (fill.side === "BUY") {
    return {
      side: "BUY",
      feeRaw: fee.toString(),
      filledNotionalRaw: maker.toString(),
      budgetImpactRaw: (maker + fee).toString(),
      tokenDeltaRaw: taker.toString()
    };
  }
  return {
    side: "SELL",
    feeRaw: fee.toString(),
    filledNotionalRaw: taker.toString(),
    proceedsRaw: (taker - fee).toString(),
    budgetImpactRaw: "0",
    inventoryDeltaRaw: maker.toString()
  };
}

function deriveTakerEconomics(fill: DecodedOrderFilled): NormalizedEconomics {
  const maker = BigInt(fill.makerAmountFilledRaw);
  const taker = BigInt(fill.takerAmountFilledRaw);
  if (fill.side === "BUY") {
    return {
      side: "SELL",
      feeRaw: "0",
      filledNotionalRaw: maker.toString(),
      proceedsRaw: maker.toString(),
      budgetImpactRaw: "0",
      inventoryDeltaRaw: taker.toString()
    };
  }
  return {
    side: "BUY",
    feeRaw: "0",
    filledNotionalRaw: taker.toString(),
    budgetImpactRaw: taker.toString(),
    tokenDeltaRaw: maker.toString()
  };
}

export function deriveEconomics(fill: DecodedOrderFilled, role: LeaderRole = "MAKER"): NormalizedEconomics {
  return role === "MAKER" ? deriveMakerEconomics(fill) : deriveTakerEconomics(fill);
}
