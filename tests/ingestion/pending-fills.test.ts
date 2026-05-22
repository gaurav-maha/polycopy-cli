import { encodeAbiParameters, encodeEventTopics, getAddress } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { CTF_EXCHANGE_V2, ORDER_FILLED_EVENT_ABI } from "../../src/constants/abi.js";
import type { Hex, RpcAdapter } from "../../src/adapters/types.js";
import { decodeOrderFilledLog } from "../../src/protocol/decode-order-filled.js";
import {
  insertPendingSourceFill,
  ingestRawLog,
  promotePendingFills
} from "../../src/ingestion/pending-fills.js";
import { safeHead } from "../../src/ingestion/cursor.js";
import type { TempDb } from "../helpers/temp-db.js";
import { createMigratedTempDb } from "../helpers/temp-db.js";

const leader = "0x9d84ce0306f8551e02efef1680475fc0f1dc1344" as Hex;
const counterparty = "0x1111111111111111111111111111111111111111" as Hex;
const blockHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex;

function makeRawLog(
  blockNumber: bigint,
  args: {
    side?: 0 | 1;
    maker?: Hex;
    taker?: Hex;
    makerAmountFilled?: bigint;
    takerAmountFilled?: bigint;
    fee?: bigint;
  } = {}
) {
  const topics = encodeEventTopics({
    abi: [ORDER_FILLED_EVENT_ABI],
    eventName: "OrderFilled",
    args: {
      orderHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
      maker: args.maker ?? leader,
      taker: args.taker ?? CTF_EXCHANGE_V2
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
      args.side ?? 0,
      123n,
      args.makerAmountFilled ?? 400000n,
      args.takerAmountFilled ?? 1000000n,
      args.fee ?? 0n,
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      "0x2222222222222222222222222222222222222222222222222222222222222222"
    ]
  );
  const suffix = blockNumber.toString(16).padStart(64, "0");
  return {
    chainId: 137 as const,
    address: CTF_EXCHANGE_V2,
    blockNumber,
    blockHash,
    transactionHash: `0x${suffix}` as Hex,
    transactionIndex: 1,
    logIndex: Number(blockNumber),
    topics,
    data
  };
}

function mockRpc(): RpcAdapter {
  return {
    getChainId: async () => 137,
    getLatestBlock: async () => ({ number: 102n, hash: blockHash, timestampMs: 1_700_000_000_000 }),
    getBlock: async (number) => ({ number, hash: blockHash, timestampMs: 1_700_000_000_000 }),
    getCode: async () => "0x",
    getLogs: async () => [],
    getTransactionReceipt: async () => ({ blockHash, logs: [] }),
    readContract: async () => {
      throw new Error("not used");
    }
  };
}

describe("pending source fills", () => {
  let tempDb: TempDb | undefined;

  afterEach(async () => {
    await tempDb?.cleanup();
    tempDb = undefined;
  });

  it("stores fills as PENDING before safe-head promotion", async () => {
    tempDb = await createMigratedTempDb();
    const raw = makeRawLog(100n);
    const decoded = decodeOrderFilledLog(raw);
    const { inserted } = insertPendingSourceFill(tempDb.db, decoded, raw);
    expect(inserted).toBe(true);
    const row = tempDb.db.prepare("SELECT status FROM source_fills WHERE id IS NOT NULL").get() as { status: string };
    expect(row.status).toBe("PENDING");
  });

  it("promotes only fills at or below safe head", async () => {
    tempDb = await createMigratedTempDb();
    ingestRawLog(tempDb.db, makeRawLog(100n), 1_700_000_000_000);
    ingestRawLog(tempDb.db, makeRawLog(101n), 1_700_000_000_000);

    const head = safeHead(102n, 2);
    expect(head).toBe(100n);

    const promoted = await promotePendingFills(tempDb.db, mockRpc(), { sourceWallets: [leader], safeHead: head });
    expect(promoted).toHaveLength(1);
    expect(promoted[0]?.blockNumber).toBe(100n);

    const pending = tempDb.db
      .prepare("SELECT COUNT(*) AS count FROM source_fills WHERE status = 'PENDING'")
      .get() as { count: number };
    expect(pending.count).toBe(1);
  });

  it("normalizes promoted fills for configured leader", async () => {
    tempDb = await createMigratedTempDb();
    ingestRawLog(tempDb.db, makeRawLog(100n), 1_700_000_000_000);
    await promotePendingFills(tempDb.db, mockRpc(), { sourceWallets: [leader], safeHead: 100n });
    const row = tempDb.db.prepare("SELECT status, source_wallet FROM source_fills LIMIT 1").get() as {
      status: string;
      source_wallet: string;
    };
    expect(row.status).toBe("NORMALIZED");
    expect(getAddress(row.source_wallet)).toBe(getAddress(leader));
  });

  it("normalizes promoted leader-taker fills from the leader perspective", async () => {
    tempDb = await createMigratedTempDb();
    ingestRawLog(
      tempDb.db,
      makeRawLog(100n, {
        side: 0,
        maker: counterparty,
        taker: leader,
        makerAmountFilled: 400000n,
        takerAmountFilled: 1000000n,
        fee: 500n
      }),
      1_700_000_000_000
    );

    const promoted = await promotePendingFills(tempDb.db, mockRpc(), { sourceWallets: [leader], safeHead: 100n });
    expect(promoted).toHaveLength(1);
    expect(promoted[0]).toMatchObject({
      sourceWallet: getAddress(leader),
      leaderRole: "TAKER",
      side: "SELL",
      feeRaw: "0",
      filledNotionalRaw: "400000",
      inventoryDeltaRaw: "1000000"
    });

    const row = tempDb.db.prepare("SELECT status, source_wallet, side, fee_raw, decoded_json FROM source_fills LIMIT 1").get() as {
      status: string;
      source_wallet: string;
      side: string;
      fee_raw: string;
      decoded_json: string;
    };
    expect(row.status).toBe("NORMALIZED");
    expect(getAddress(row.source_wallet)).toBe(getAddress(leader));
    expect(row.side).toBe("SELL");
    expect(row.fee_raw).toBe("0");
    expect(JSON.parse(row.decoded_json)).toMatchObject({ leaderRole: "TAKER", sourceWallet: getAddress(leader) });
  });

  it("skips leader-to-leader fills without promoting an arbitrary leader side", async () => {
    tempDb = await createMigratedTempDb();
    ingestRawLog(
      tempDb.db,
      makeRawLog(100n, {
        side: 0,
        maker: leader,
        taker: counterparty,
        makerAmountFilled: 400000n,
        takerAmountFilled: 1000000n
      }),
      1_700_000_000_000
    );

    const promoted = await promotePendingFills(tempDb.db, mockRpc(), {
      sourceWallets: [leader, counterparty],
      safeHead: 100n
    });

    expect(promoted).toHaveLength(0);
    const row = tempDb.db.prepare("SELECT status, skip_reason, source_wallet FROM source_fills LIMIT 1").get() as {
      status: string;
      skip_reason: string;
      source_wallet: string | null;
    };
    expect(row).toEqual({
      status: "SKIPPED",
      skip_reason: "ROLE_AMBIGUOUS",
      source_wallet: null
    });
  });
});
