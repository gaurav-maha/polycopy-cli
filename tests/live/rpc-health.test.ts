import { describe, expect, it } from "vitest";
import type { BlockRef, RpcAdapter } from "../../src/adapters/types.js";
import { assertClockSkew, checkRpcHealth } from "../../src/live/rpc-health.js";

const blockHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;

function mockRpc(blocks: BlockRef[]): RpcAdapter {
  return {
    getChainId: async () => 137,
    getLatestBlock: async () => blocks[blocks.length - 1]!,
    getBlock: async (number) => blocks.find((block) => block.number === number) ?? blocks[blocks.length - 1]!,
    getCode: async () => "0x",
    getLogs: async () => [],
    getTransactionReceipt: async () => ({ blockHash, logs: [] }),
    readContract: async () => {
      throw new Error("not used");
    }
  };
}

describe("rpc health", () => {
  it("passes when both providers agree on block hash", async () => {
    const nowMs = 1_700_000_000_000;
    const head: BlockRef = { number: 100n, hash: blockHash, timestampMs: nowMs - 1_000 };
    const result = await checkRpcHealth({
      primary: mockRpc([head]),
      fallback: mockRpc([head]),
      nowMs,
      maxLagMs: 30_000
    });
    expect(result.ok).toBe(true);
    expect(result.hashDisagreement).toBe(false);
  });

  it("fails when providers disagree on block hash", async () => {
    const nowMs = 1_700_000_000_000;
    const primaryHead: BlockRef = { number: 100n, hash: blockHash, timestampMs: nowMs - 1_000 };
    const fallbackHead: BlockRef = {
      number: 100n,
      hash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      timestampMs: nowMs - 1_000
    };
    const result = await checkRpcHealth({
      primary: mockRpc([primaryHead]),
      fallback: mockRpc([fallbackHead]),
      nowMs,
      maxLagMs: 30_000
    });
    expect(result.ok).toBe(false);
    expect(result.hashDisagreement).toBe(true);
  });

  it("treats stale heads as lag, not local clock skew", () => {
    expect(() =>
      assertClockSkew({
        blockTimestampMs: 1_700_000_000_000 - 10_000,
        nowMs: 1_700_000_000_000,
        maxSkewMs: 3_000
      })
    ).not.toThrow();
    expect(() =>
      assertClockSkew({
        blockTimestampMs: 1_700_000_000_000 + 10_000,
        nowMs: 1_700_000_000_000,
        maxSkewMs: 3_000
      })
    ).toThrow(/clock skew/);
  });
});
