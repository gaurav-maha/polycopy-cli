import type { MarketMetadata } from "../adapters/types.js";
import type { Clock } from "../adapters/types.js";

const FIXTURE_MARKETS: Record<string, MarketMetadata> = {
  "100000000000000000001": fixtureMarket("100000000000000000001"),
  "100000000000000000002": fixtureMarket("100000000000000000002"),
  "100000000000000000003": fixtureMarket("100000000000000000003"),
  "100000000000000000004": fixtureMarket("100000000000000000004"),
  "100000000000000000005": fixtureMarket("100000000000000000005"),
  "100000000000000000006": fixtureMarket("100000000000000000006"),
  "100000000000000000007": fixtureMarket("100000000000000000007")
};

function fixtureMarket(tokenId: string): MarketMetadata {
  return {
    tokenId,
    source: "FIXTURE",
    receivedAtMs: 1_779_408_000_000,
    conditionId: `0x${"a".repeat(64)}`,
    outcome: "YES",
    negRisk: false,
    active: true,
    resolved: false,
    paused: false,
    tickSize: "0.01",
    tickSizePpm: 10_000,
    minOrderSizeSharesDecimal: "0.000001",
    feeConfig: { r: "0", e: "0", to: `0x${"b".repeat(40)}`, raw: { fixture: true } }
  };
}

export function getFixtureMarketMetadata(tokenId: string, clock?: Clock): MarketMetadata {
  const base = FIXTURE_MARKETS[tokenId] ?? fixtureMarket(tokenId);
  const receivedAtMs = clock?.nowMs() ?? base.receivedAtMs;
  return { ...base, receivedAtMs };
}

export function assertMarketLifecycle(metadata: MarketMetadata): { ok: true } | { ok: false; skipReason: "MARKET_PAUSED" | "MARKET_RESOLVED" } {
  if (metadata.resolved) return { ok: false, skipReason: "MARKET_RESOLVED" };
  if (metadata.paused || !metadata.active) return { ok: false, skipReason: "MARKET_PAUSED" };
  return { ok: true };
}

export function sharesRawFromNotional(notionalRaw: bigint, pricePpm: number): bigint {
  if (pricePpm <= 0) return 0n;
  return (notionalRaw * 1_000_000n) / BigInt(pricePpm);
}

export function snapTickPpm(side: "BUY" | "SELL", rawPpm: number, tickSizePpm: number): number {
  if (tickSizePpm <= 0) return rawPpm;
  return side === "BUY" ? Math.floor(rawPpm / tickSizePpm) * tickSizePpm : Math.ceil(rawPpm / tickSizePpm) * tickSizePpm;
}
