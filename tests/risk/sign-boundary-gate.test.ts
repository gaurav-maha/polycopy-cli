import { describe, expect, it } from "vitest";
import { evaluateSignBoundaryReGate } from "../../src/risk/sign-boundary-gate.js";

const config = {
  maxBookAgeMs: 800,
  maxDriftPpm: 30_000,
  maxBuyPpm: 980_000,
  minSellPpm: 20_000,
  slippageCapPpm: 50_000
};

describe("sign-boundary re-gate", () => {
  it("skips with STALE_AT_SIGN when the refreshed book is too old", async () => {
    const result = await evaluateSignBoundaryReGate(
      {
        tokenId: "123",
        side: "BUY",
        leaderPricePpm: 500_000,
        approvedNotionalRaw: 100_000n,
        tickSizePpm: 10_000,
        nowMs: 1_000_000,
        fetchBook: async () => ({
          spreadPpm: 10_000,
          vwapPpm: 505_000,
          visibleDepthRaw: "5000000",
          intendedSizeRaw: "200000",
          bookSource: "REST",
          wsAgeMs: Number.POSITIVE_INFINITY,
          restAgeMs: 0,
          restCrossCheckPpm: 505_000,
          restCrossCheckAgeMs: 0,
          receivedAtMs: 998_000
        })
      },
      config
    );

    expect(result).toMatchObject({ ok: false, skipReason: "STALE_AT_SIGN" });
    if (!result.ok) {
      expect(result.signBoundarySnapshot.failure).toBe("book_age");
    }
  });

  it("skips with STALE_AT_SIGN when refreshed BUY drift exceeds the cap", async () => {
    const result = await evaluateSignBoundaryReGate(
      {
        tokenId: "123",
        side: "BUY",
        leaderPricePpm: 500_000,
        approvedNotionalRaw: 100_000n,
        tickSizePpm: 10_000,
        nowMs: 1_000_000,
        fetchBook: async () => ({
          spreadPpm: 10_000,
          vwapPpm: 540_000,
          visibleDepthRaw: "5000000",
          intendedSizeRaw: "200000",
          bookSource: "REST",
          wsAgeMs: Number.POSITIVE_INFINITY,
          restAgeMs: 0,
          restCrossCheckPpm: 540_000,
          restCrossCheckAgeMs: 0,
          receivedAtMs: 999_900
        })
      },
      config
    );

    expect(result).toMatchObject({ ok: false, skipReason: "STALE_AT_SIGN" });
    if (!result.ok) {
      expect(result.signBoundarySnapshot.failure).toBe("drift_buy");
    }
  });

  it("passes with refreshed book age and drift within limits", async () => {
    const result = await evaluateSignBoundaryReGate(
      {
        tokenId: "123",
        side: "BUY",
        leaderPricePpm: 500_000,
        approvedNotionalRaw: 100_000n,
        tickSizePpm: 10_000,
        nowMs: 1_000_000,
        fetchBook: async () => ({
          spreadPpm: 10_000,
          vwapPpm: 505_000,
          visibleDepthRaw: "5000000",
          intendedSizeRaw: "198019",
          bookSource: "REST",
          wsAgeMs: Number.POSITIVE_INFINITY,
          restAgeMs: 0,
          restCrossCheckPpm: 505_000,
          restCrossCheckAgeMs: 0,
          receivedAtMs: 999_500
        })
      },
      config
    );

    expect(result).toMatchObject({
      ok: true,
      limitPricePpm: 550_000,
      intendedSizeRaw: 198_019n
    });
  });
});
