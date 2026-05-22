import type { ClobRestAdapter, OrderBookLevel } from "../adapters/types.js";
import type { BookWalkResult } from "../market/book-oracle.js";
import { snapTickPpm } from "../market/metadata.js";

export type SignBoundaryReGateConfig = {
  maxBookAgeMs: number;
  maxDriftPpm: number;
  maxBuyPpm: number;
  minSellPpm: number;
  slippageCapPpm: number;
};

export type SignBoundaryReGateInput = {
  tokenId: string;
  side: "BUY" | "SELL";
  leaderPricePpm: number;
  approvedNotionalRaw: bigint;
  tickSizePpm: number;
  nowMs: number;
  fetchBook?: (args: {
    tokenId: string;
    side: "BUY" | "SELL";
    intendedNotionalRaw: bigint;
  }) => Promise<BookWalkResult & { receivedAtMs: number }>;
  clob?: ClobRestAdapter;
};

export type SignBoundaryReGatePass = {
  ok: true;
  book: BookWalkResult;
  limitPricePpm: number;
  intendedSizeRaw: bigint;
  signBoundarySnapshot: Record<string, unknown>;
};

export type SignBoundaryReGateFail = {
  ok: false;
  skipReason: "STALE_AT_SIGN";
  signBoundarySnapshot: Record<string, unknown>;
};

export type SignBoundaryReGateResult = SignBoundaryReGatePass | SignBoundaryReGateFail;

export async function evaluateSignBoundaryReGate(
  input: SignBoundaryReGateInput,
  config: SignBoundaryReGateConfig
): Promise<SignBoundaryReGateResult> {
  const signBoundarySnapshot: Record<string, unknown> = {
    gate: "sign_boundary",
    checkedAtMs: input.nowMs,
    leaderPricePpm: input.leaderPricePpm,
    approvedNotionalRaw: input.approvedNotionalRaw.toString()
  };

  let book: BookWalkResult & { receivedAtMs: number };
  try {
    book = input.fetchBook
      ? await input.fetchBook({
          tokenId: input.tokenId,
          side: input.side,
          intendedNotionalRaw: input.approvedNotionalRaw
        })
      : await fetchBookFromClob(input.clob!, input);
  } catch (error) {
    signBoundarySnapshot.bookError = error instanceof Error ? error.message : String(error);
    return { ok: false, skipReason: "STALE_AT_SIGN", signBoundarySnapshot };
  }

  const bookAgeMs = input.nowMs - book.receivedAtMs;
  signBoundarySnapshot.book = book;
  signBoundarySnapshot.bookAgeMs = bookAgeMs;
  signBoundarySnapshot.maxBookAgeMs = config.maxBookAgeMs;

  if (bookAgeMs > config.maxBookAgeMs) {
    signBoundarySnapshot.failure = "book_age";
    return { ok: false, skipReason: "STALE_AT_SIGN", signBoundarySnapshot };
  }

  if (input.side === "BUY" && book.vwapPpm > input.leaderPricePpm + config.maxDriftPpm) {
    signBoundarySnapshot.failure = "drift_buy";
    signBoundarySnapshot.driftPpm = book.vwapPpm - input.leaderPricePpm;
    return { ok: false, skipReason: "STALE_AT_SIGN", signBoundarySnapshot };
  }
  if (input.side === "SELL" && book.vwapPpm < input.leaderPricePpm - config.maxDriftPpm) {
    signBoundarySnapshot.failure = "drift_sell";
    signBoundarySnapshot.driftPpm = input.leaderPricePpm - book.vwapPpm;
    return { ok: false, skipReason: "STALE_AT_SIGN", signBoundarySnapshot };
  }

  const limitPricePpm = snapTickPpm(
    input.side,
    input.side === "BUY"
      ? Math.min(config.maxBuyPpm, input.leaderPricePpm + config.slippageCapPpm)
      : Math.max(config.minSellPpm, input.leaderPricePpm - config.slippageCapPpm),
    input.tickSizePpm
  );
  signBoundarySnapshot.limitPpm = limitPricePpm;

  return {
    ok: true,
    book,
    limitPricePpm,
    intendedSizeRaw: BigInt(book.intendedSizeRaw),
    signBoundarySnapshot
  };
}

async function fetchBookFromClob(
  clob: ClobRestAdapter,
  input: SignBoundaryReGateInput
): Promise<BookWalkResult & { receivedAtMs: number }> {
  const snapshot = await clob.getOrderBook(input.tokenId);
  const levels = input.side === "BUY" ? snapshot.asks : snapshot.bids;
  if (levels.length === 0) {
    throw new Error("BOOK_GAP");
  }
  const walk = walkOrderBookSide(input.side, levels, input.approvedNotionalRaw, snapshot);
  return { ...walk, receivedAtMs: snapshot.receivedAtMs };
}

function walkOrderBookSide(
  side: "BUY" | "SELL",
  levels: OrderBookLevel[],
  targetNotional: bigint,
  snapshot: { asks: OrderBookLevel[]; bids: OrderBookLevel[]; source: "WS" | "REST"; receivedAtMs: number }
): BookWalkResult {
  const sorted =
    side === "BUY"
      ? [...levels].sort((a, b) => a.pricePpm - b.pricePpm)
      : [...levels].sort((a, b) => b.pricePpm - a.pricePpm);
  let remaining = targetNotional;
  let notional = 0n;
  let shares = 0n;
  for (const level of sorted) {
    const levelNotional = (BigInt(level.sizeRaw) * BigInt(level.pricePpm)) / 1_000_000n;
    const takeNotional = remaining < levelNotional ? remaining : levelNotional;
    if (takeNotional <= 0n) continue;
    shares += (takeNotional * 1_000_000n) / BigInt(level.pricePpm);
    notional += takeNotional;
    remaining -= takeNotional;
    if (remaining <= 0n) break;
  }
  if (notional < targetNotional || shares === 0n) {
    throw new Error("DEPTH_INSUFFICIENT");
  }
  const bestAsk = snapshot.asks.length ? Math.min(...snapshot.asks.map((level) => level.pricePpm)) : Number.POSITIVE_INFINITY;
  const bestBid = snapshot.bids.length ? Math.max(...snapshot.bids.map((level) => level.pricePpm)) : 0;
  return {
    spreadPpm: Math.max(0, bestAsk - bestBid),
    vwapPpm: Number((notional * 1_000_000n) / shares),
    visibleDepthRaw: sorted.reduce((sum, level) => sum + (BigInt(level.sizeRaw) * BigInt(level.pricePpm)) / 1_000_000n, 0n).toString(),
    intendedSizeRaw: shares.toString(),
    bookSource: snapshot.source,
    wsAgeMs: snapshot.source === "WS" ? 0 : Number.POSITIVE_INFINITY,
    restAgeMs: snapshot.source === "REST" ? 0 : Number.POSITIVE_INFINITY,
    restCrossCheckPpm: side === "BUY" ? bestAsk : bestBid,
    restCrossCheckAgeMs: 0
  };
}

export function signBoundaryConfigFromRiskAndMarket(
  risk: {
    maxDriftPpm: number;
    maxBuyPpm: number;
    minSellPpm: number;
    slippageCapPpm: number;
  },
  market: { maxBookAgeMs: number }
): SignBoundaryReGateConfig {
  return {
    maxBookAgeMs: market.maxBookAgeMs,
    maxDriftPpm: risk.maxDriftPpm,
    maxBuyPpm: risk.maxBuyPpm,
    minSellPpm: risk.minSellPpm,
    slippageCapPpm: risk.slippageCapPpm
  };
}
