import { describe, expect, it } from "vitest";
import { safeHead } from "../../src/ingestion/cursor.js";

describe("ingestion cursor", () => {
  it("computes safe head from latest block and confirmation depth", () => {
    expect(safeHead(100n, 2)).toBe(98n);
    expect(safeHead(1n, 2)).toBe(0n);
    expect(safeHead(0n, 2)).toBe(0n);
  });
});
