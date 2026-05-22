import { encodeAbiParameters, encodeEventTopics } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { CTF_EXCHANGE_V2, ORDER_FILLED_EVENT_ABI } from "../../src/constants/abi.js";
import type { Hex, RpcAdapter } from "../../src/adapters/types.js";
import { catchUpLogs } from "../../src/ingestion/catch-up.js";
import type { TempDb } from "../helpers/temp-db.js";
import { createMigratedTempDb } from "../helpers/temp-db.js";

const leaderA = "0x9d84ce0306f8551e02efef1680475fc0f1dc1344" as Hex;
const leaderB = "0x1111111111111111111111111111111111111111" as Hex;
const blockHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex;

function makeRawLog(blockNumber: bigint, maker: Hex, txSuffix: string, taker: Hex = CTF_EXCHANGE_V2) {
  const topics = encodeEventTopics({
    abi: [ORDER_FILLED_EVENT_ABI],
    eventName: "OrderFilled",
    args: {
      orderHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
      maker,
      taker
    }
  }) as Hex[];
  const data = encodeAbiParameters(
    [
      { type: "uint8" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "bytes32" },
      { type: "bytes32" }
    ],
    [
      0,
      123n,
      400000n,
      1000000n,
      0n,
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      "0x2222222222222222222222222222222222222222222222222222222222222222"
    ]
  );
  return {
    chainId: 137 as const,
    address: CTF_EXCHANGE_V2,
    blockNumber,
    blockHash,
    transactionHash: `0x${txSuffix}` as Hex,
    transactionIndex: 1,
    logIndex: Number(blockNumber),
    topics,
    data
  };
}

describe("multi-leader catch-up", () => {
  let tempDb: TempDb | undefined;

  afterEach(async () => {
    await tempDb?.cleanup();
    tempDb = undefined;
  });

  it("merges logs from multiple leaders in block order", async () => {
    tempDb = await createMigratedTempDb();
    const rpc: RpcAdapter = {
      getChainId: async () => 137,
      getLatestBlock: async () => ({ number: 100n, hash: blockHash, timestampMs: 1_700_000_000_000 }),
      getBlock: async (number) => ({ number, hash: blockHash, timestampMs: 1_700_000_000_000 }),
      getCode: async () => "0x",
      getLogs: async ({ fromBlock, toBlock }) => {
        if (fromBlock > toBlock) return [];
        return [
          makeRawLog(100n, leaderB, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
          makeRawLog(100n, leaderA, "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc")
        ];
      },
      getTransactionReceipt: async () => ({ blockHash, logs: [] }),
      readContract: async () => {
        throw new Error("not used");
      }
    };

    const inserted = await catchUpLogs({
      rpc,
      db: tempDb.db,
      leaders: [leaderA, leaderB],
      fromBlock: 100n,
      toBlock: 100n
    });

    expect(inserted).toBe(2);
    const rows = tempDb.db
      .prepare("SELECT source_wallet FROM source_fills ORDER BY tx_hash ASC")
      .all() as Array<{ source_wallet: string }>;
    expect(rows).toHaveLength(2);
  });

  it("fetches both maker-topic and taker-topic fills for a leader", async () => {
    tempDb = await createMigratedTempDb();
    let calls = 0;
    const rpc: RpcAdapter = {
      getChainId: async () => 137,
      getLatestBlock: async () => ({ number: 100n, hash: blockHash, timestampMs: 1_700_000_000_000 }),
      getBlock: async (number) => ({ number, hash: blockHash, timestampMs: 1_700_000_000_000 }),
      getCode: async () => "0x",
      getLogs: async () => {
        calls += 1;
        if (calls === 1) {
          return [makeRawLog(100n, leaderA, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", leaderB)];
        }
        if (calls === 2) {
          return [makeRawLog(101n, leaderB, "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd", leaderA)];
        }
        return [];
      },
      getTransactionReceipt: async () => ({ blockHash, logs: [] }),
      readContract: async () => {
        throw new Error("not used");
      }
    };

    const inserted = await catchUpLogs({
      rpc,
      db: tempDb.db,
      leaders: [leaderA],
      fromBlock: 100n,
      toBlock: 101n
    });

    expect(calls).toBe(2);
    expect(inserted).toBe(2);
  });
});
