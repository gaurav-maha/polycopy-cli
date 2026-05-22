import type { Clock, ClobRestAdapter, MarketWsAdapter, OrderBookLevel, OrderBookSnapshot } from "../adapters/types.js";

export type BookWalkResult = {
  spreadPpm: number;
  vwapPpm: number;
  visibleDepthRaw: string;
  intendedSizeRaw: string;
  bookSource: "WS" | "REST";
  wsAgeMs: number;
  restAgeMs: number;
  restCrossCheckPpm: number;
  restCrossCheckAgeMs: number;
};

export type BookOracleConfig = {
  wsStaleMs: number;
  restStaleMs: number;
  bookMismatchPpm: number;
  bookRestCrossCheckMaxAgeMs: number;
  maxBookAgeMs: number;
};

export type BookOracleFault = "WS_GAP" | "WS_RECONNECT" | null;

function bestAsk(levels: OrderBookLevel[]): number {
  return levels.length ? Math.min(...levels.map((level) => level.pricePpm)) : Number.POSITIVE_INFINITY;
}

function bestBid(levels: OrderBookLevel[]): number {
  return levels.length ? Math.max(...levels.map((level) => level.pricePpm)) : 0;
}

function walkBook(side: "BUY" | "SELL", levels: OrderBookLevel[], targetNotional: bigint): BookWalkResult {
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
  const asks = side === "BUY" ? sorted : [];
  const bids = side === "SELL" ? sorted : [];
  return {
    spreadPpm: Math.max(0, bestAsk(asks.length ? asks : sorted) - bestBid(bids.length ? bids : sorted)),
    vwapPpm: Number((notional * 1_000_000n) / shares),
    visibleDepthRaw: sorted.reduce((sum, level) => sum + (BigInt(level.sizeRaw) * BigInt(level.pricePpm)) / 1_000_000n, 0n).toString(),
    intendedSizeRaw: shares.toString(),
    bookSource: "WS",
    wsAgeMs: 0,
    restAgeMs: 0,
    restCrossCheckPpm: side === "BUY" ? bestAsk(sorted) : bestBid(sorted),
    restCrossCheckAgeMs: 0
  };
}

export class BookOracle {
  readonly #clock: Clock;
  readonly #ws: MarketWsAdapter;
  readonly #rest: ClobRestAdapter;
  readonly #config: BookOracleConfig;
  #fault: BookOracleFault = null;

  constructor(args: { clock: Clock; ws: MarketWsAdapter; rest: ClobRestAdapter; config: BookOracleConfig }) {
    this.#clock = args.clock;
    this.#ws = args.ws;
    this.#rest = args.rest;
    this.#config = args.config;
  }

  setFault(fault: BookOracleFault): void {
    this.#fault = fault;
  }

  invalidate(tokenId: string, reason: string): void {
    this.#ws.invalidate(tokenId, reason);
  }

  async fetchWalk(args: { tokenId: string; side: "BUY" | "SELL"; intendedNotionalRaw: bigint }): Promise<BookWalkResult> {
    if (this.#fault === "WS_GAP" || this.#fault === "WS_RECONNECT") {
      throw new Error("BOOK_GAP");
    }

    const nowMs = this.#clock.nowMs();
    const wsSnapshot = await this.#ws.getSnapshot(args.tokenId);
    const restSnapshot = await this.#rest.getOrderBook(args.tokenId);
    const wsAgeMs = wsSnapshot ? nowMs - wsSnapshot.receivedAtMs : Number.POSITIVE_INFINITY;
    const restAgeMs = nowMs - restSnapshot.receivedAtMs;

    if (wsAgeMs <= this.#config.wsStaleMs && wsSnapshot) {
      if (wsSnapshot.asks.length === 0 || wsSnapshot.bids.length === 0) {
        throw new Error("STALE_BOOK");
      }
      const sidePrice =
        args.side === "BUY" ? bestAsk(restSnapshot.asks) : bestBid(restSnapshot.bids);
      const wsPrice = args.side === "BUY" ? bestAsk(wsSnapshot.asks) : bestBid(wsSnapshot.bids);
      if (Math.abs(wsPrice - sidePrice) > this.#config.bookMismatchPpm) {
        throw new Error("BOOK_SOURCE_MISMATCH");
      }
      const walked = walkBook(args.side, args.side === "BUY" ? wsSnapshot.asks : wsSnapshot.bids, args.intendedNotionalRaw);
      return {
        ...walked,
        bookSource: "WS",
        wsAgeMs,
        restAgeMs,
        restCrossCheckPpm: sidePrice,
        restCrossCheckAgeMs: restAgeMs
      };
    }

    if (restAgeMs <= this.#config.restStaleMs) {
      const levels = args.side === "BUY" ? restSnapshot.asks : restSnapshot.bids;
      const walked = walkBook(args.side, levels, args.intendedNotionalRaw);
      return {
        ...walked,
        bookSource: "REST",
        wsAgeMs,
        restAgeMs,
        restCrossCheckPpm: args.side === "BUY" ? bestAsk(restSnapshot.asks) : bestBid(restSnapshot.bids),
        restCrossCheckAgeMs: restAgeMs
      };
    }

    throw new Error("STALE_BOOK");
  }
}

export function walkSnapshot(args: {
  side: "BUY" | "SELL";
  snapshot: OrderBookSnapshot;
  intendedNotionalRaw: bigint;
}): BookWalkResult {
  const levels = args.side === "BUY" ? args.snapshot.asks : args.snapshot.bids;
  const walked = walkBook(args.side, levels, args.intendedNotionalRaw);
  return { ...walked, bookSource: args.snapshot.source, wsAgeMs: 0, restAgeMs: 0, restCrossCheckPpm: walked.vwapPpm, restCrossCheckAgeMs: 0 };
}
