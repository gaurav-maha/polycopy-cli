import type { MarketMetadata } from "../adapters/types.js";

export type BuyFeeConfig = Pick<MarketMetadata["feeConfig"], "r" | "e" | "to">;

const onePpm = 1_000_000n;
const onePpmSquared = onePpm * onePpm;

export function compactFeeConfig(feeConfig: MarketMetadata["feeConfig"]): BuyFeeConfig {
  return {
    r: String(feeConfig.r),
    e: String(feeConfig.e),
    to: String(feeConfig.to)
  };
}

export function estimateBuyPusdFeeHeadroomRaw(args: {
  notionalRaw: bigint;
  limitPricePpm: number;
  feeConfig?: Partial<BuyFeeConfig> | null;
}): bigint {
  if (args.notionalRaw <= 0n) return 0n;
  if (args.limitPricePpm <= 0 || args.limitPricePpm >= 1_000_000) {
    throw new Error(`invalid BUY limit price ppm for fee estimate: ${args.limitPricePpm}`);
  }

  const rate = decimalRatio(args.feeConfig?.r ?? "0");
  const exponent = integerExponent(args.feeConfig?.e ?? "0");
  if (rate.num === 0n) return 0n;

  if (exponent === null) {
    return estimateWithNumberMath(args.notionalRaw, args.limitPricePpm, rate, args.feeConfig?.e ?? "0");
  }

  const pricePpm = BigInt(args.limitPricePpm);
  const priceTimesInverse = pricePpm * (onePpm - pricePpm);
  const numerator =
    args.notionalRaw *
    rate.num *
    powBigint(priceTimesInverse, exponent) *
    onePpm;
  const denominator = rate.den * powBigint(onePpmSquared, exponent) * pricePpm;
  return ceilDiv(numerator, denominator);
}

export function totalBuyPusdRequiredRaw(args: {
  notionalRaw: bigint;
  feeHeadroomRaw: bigint;
}): bigint {
  return args.notionalRaw + args.feeHeadroomRaw;
}

function decimalRatio(value: string | number): { num: bigint; den: bigint } {
  const raw = String(value).trim();
  if (!raw || raw === "0") return { num: 0n, den: 1n };
  if (/^\d+$/.test(raw)) return { num: BigInt(raw), den: 1n };

  const match = raw.match(/^(\d*)\.(\d+)$/);
  if (!match) {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error(`invalid fee rate: ${raw}`);
    }
    return decimalRatio(parsed.toFixed(12).replace(/0+$/, "").replace(/\.$/, ""));
  }

  const whole = match[1] || "0";
  const fractional = match[2];
  const den = 10n ** BigInt(fractional.length);
  return {
    num: BigInt(`${whole}${fractional}`),
    den
  };
}

function integerExponent(value: string | number): number | null {
  const raw = String(value).trim();
  if (/^\d+$/.test(raw)) return Number(raw);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`invalid fee exponent: ${raw}`);
  }
  return Number.isInteger(parsed) ? parsed : null;
}

function estimateWithNumberMath(
  notionalRaw: bigint,
  limitPricePpm: number,
  rate: { num: bigint; den: bigint },
  exponent: string | number
): bigint {
  const price = limitPricePpm / 1_000_000;
  const feeRate = Number(rate.num) / Number(rate.den);
  const fee = Number(notionalRaw) * feeRate * (price * (1 - price)) ** Number(exponent) / price;
  if (!Number.isFinite(fee) || fee < 0) {
    throw new Error("invalid BUY fee estimate");
  }
  return BigInt(Math.ceil(fee));
}

function powBigint(base: bigint, exponent: number): bigint {
  let result = 1n;
  for (let index = 0; index < exponent; index += 1) {
    result *= base;
  }
  return result;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error("fee estimate denominator must be positive");
  return (numerator + denominator - 1n) / denominator;
}
