import { describe, expect, it } from "vitest";
import { decimalSharesToRaw, parseClobMatchTime } from "../../src/adapters/polymarket-clob.js";

describe("Polymarket CLOB adapter", () => {
  it("parses CLOB match_time numeric strings as seconds", () => {
    expect(parseClobMatchTime("1779502860", 0)).toBe("2026-05-23T02:21:00.000Z");
  });

  it("parses CLOB match_time millisecond values and ISO strings", () => {
    expect(parseClobMatchTime(1779502860123, 0)).toBe("2026-05-23T02:21:00.123Z");
    expect(parseClobMatchTime("2026-05-22T22:21:00.123Z", 0)).toBe("2026-05-22T22:21:00.123Z");
  });

  it("falls back instead of throwing on malformed CLOB match_time values", () => {
    expect(parseClobMatchTime("not-a-date", Date.parse("2026-05-22T22:22:00.000Z"))).toBe("2026-05-22T22:22:00.000Z");
  });

  it("parses CLOB decimal share strings without floating point drift", () => {
    expect(decimalSharesToRaw("16.666665")).toBe("16666665");
    expect(decimalSharesToRaw("16.6666645")).toBe("16666665");
    expect(decimalSharesToRaw("6.89655")).toBe("6896550");
  });
});
