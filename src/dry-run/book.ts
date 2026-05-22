import { BookWalkResult } from "../risk/gates.js";
import type { MarketMetadata } from "../adapters/types.js";

type ClobBookLevel = { price: string; size: string };
type ClobBookResponse = {
  bids?: ClobBookLevel[];
  asks?: ClobBookLevel[];
  min_order_size?: string;
  tick_size?: string;
  neg_risk?: boolean;
};

function decimalPriceToPpm(price: string): number {
  return Math.round(Number.parseFloat(price) * 1_000_000);
}

function decimalSharesToRaw(size: string): bigint {
  return BigInt(Math.floor(Number.parseFloat(size) * 1_000_000));
}

async function fetchPublicClobBook(tokenId: string): Promise<ClobBookResponse> {
  const response = await fetch(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenId)}`, {
    headers: { accept: "application/json" }
  });
  if (!response.ok) {
    throw new Error(`CLOB book HTTP ${response.status}`);
  }
  return (await response.json()) as ClobBookResponse;
}

export async function fetchPublicClobMarketMetadata(tokenId: string): Promise<MarketMetadata> {
  const raw = await fetchPublicClobBook(tokenId);
  const tickSize = raw.tick_size ?? "0.01";
  return {
    tokenId,
    source: "REST",
    receivedAtMs: Date.now(),
    conditionId: `0x${"0".repeat(64)}`,
    outcome: "",
    negRisk: raw.neg_risk ?? false,
    active: true,
    resolved: false,
    paused: false,
    tickSize,
    tickSizePpm: Math.round(Number.parseFloat(tickSize) * 1_000_000),
    minOrderSizeSharesDecimal: raw.min_order_size ?? "0",
    feeConfig: { r: "0", e: "0", to: `0x${"0".repeat(40)}`, raw }
  };
}

export async function fetchPublicClobBookWalk(args: {
  tokenId: string;
  side: "BUY" | "SELL";
  intendedNotionalRaw: string;
}): Promise<BookWalkResult> {
  const book = await fetchPublicClobBook(args.tokenId);
  const asks = (book.asks ?? []).map((level) => ({ pricePpm: decimalPriceToPpm(level.price), sizeRaw: decimalSharesToRaw(level.size) }));
  const bids = (book.bids ?? []).map((level) => ({ pricePpm: decimalPriceToPpm(level.price), sizeRaw: decimalSharesToRaw(level.size) }));
  if (asks.length === 0 || bids.length === 0) {
    throw new Error("CLOB book missing executable bids or asks");
  }
  const bestAsk = Math.min(...asks.map((level) => level.pricePpm));
  const bestBid = Math.max(...bids.map((level) => level.pricePpm));
  const levels = args.side === "BUY" ? asks.sort((a, b) => a.pricePpm - b.pricePpm) : bids.sort((a, b) => b.pricePpm - a.pricePpm);
  const targetNotional = BigInt(args.intendedNotionalRaw);
  let remaining = targetNotional;
  let notional = 0n;
  let shares = 0n;
  for (const level of levels) {
    const levelNotional = (level.sizeRaw * BigInt(level.pricePpm)) / 1_000_000n;
    const takeNotional = remaining < levelNotional ? remaining : levelNotional;
    if (takeNotional <= 0n) continue;
    const takeShares = (takeNotional * 1_000_000n) / BigInt(level.pricePpm);
    notional += takeNotional;
    shares += takeShares;
    remaining -= takeNotional;
    if (remaining <= 0n) break;
  }
  if (notional < targetNotional || shares === 0n) {
    throw new Error("CLOB book has insufficient visible depth");
  }
  return {
    spreadPpm: Math.max(0, bestAsk - bestBid),
    vwapPpm: Number((notional * 1_000_000n) / shares),
    visibleDepthRaw: levels
      .reduce((sum, level) => sum + (level.sizeRaw * BigInt(level.pricePpm)) / 1_000_000n, 0n)
      .toString(),
    intendedSizeRaw: shares.toString(),
    bookSource: "REST",
    wsAgeMs: Number.POSITIVE_INFINITY,
    restAgeMs: 0,
    restCrossCheckPpm: args.side === "BUY" ? bestAsk : bestBid,
    restCrossCheckAgeMs: 0
  };
}
