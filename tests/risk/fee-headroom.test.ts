import { describe, expect, it } from "vitest";
import { estimateBuyPusdFeeHeadroomRaw } from "../../src/risk/fee-headroom.js";

describe("BUY fee headroom estimation", () => {
  it("matches the SDK fee adjustment formula for a typical paid market", () => {
    expect(
      estimateBuyPusdFeeHeadroomRaw({
        notionalRaw: 9_988_248n,
        limitPricePpm: 290_000,
        feeConfig: { r: "0.07", e: "1", to: "0x0000000000000000000000000000000000000000" }
      })
    ).toBe(496_416n);
  });

  it("ceil-rounds fractional raw fees conservatively", () => {
    expect(
      estimateBuyPusdFeeHeadroomRaw({
        notionalRaw: 25n,
        limitPricePpm: 500_000,
        feeConfig: { r: "0.07", e: "1", to: "0x0000000000000000000000000000000000000000" }
      })
    ).toBe(1n);
  });
});
