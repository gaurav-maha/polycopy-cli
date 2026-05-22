import { describe, expect, it } from "vitest";
import type { ChainLog, Hex, RpcAdapter } from "../../src/adapters/types.js";
import { verifyReceiptLogTuple } from "../../src/ingestion/receipt-verification.js";

const txHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex;
const blockHash = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Hex;
const address = "0xE111180000d2663C0091e4f400237545B87B996B" as Hex;
const topic = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" as Hex;

function makeLog(overrides: Partial<ChainLog> = {}): ChainLog {
  return {
    chainId: 137,
    address,
    blockNumber: 100n,
    blockHash,
    transactionHash: txHash,
    transactionIndex: 0,
    logIndex: 3,
    topics: [topic],
    data: "0x1234",
    ...overrides
  };
}

function makeRpc(receiptLog: ChainLog, receiptBlockHash: Hex = blockHash): RpcAdapter {
  return {
    getChainId: async () => 137,
    getLatestBlock: async () => ({ number: 100n, hash: blockHash, timestampMs: 1 }),
    getBlock: async (number) => ({ number, hash: blockHash, timestampMs: 1 }),
    getCode: async () => "0x",
    getLogs: async () => [],
    getTransactionReceipt: async () => ({ blockHash: receiptBlockHash, logs: [receiptLog] }),
    readContract: async () => {
      throw new Error("not used");
    }
  };
}

describe("receipt log tuple verification", () => {
  it("accepts an independent receipt containing the exact source log tuple", async () => {
    const log = makeLog();

    await expect(verifyReceiptLogTuple(makeRpc(log), log)).resolves.toEqual({ ok: true });
  });

  it("accepts matching logs when the source log index was stored as a hex quantity", async () => {
    const sourceLog = makeLog({ logIndex: "0x2b6" as unknown as number });
    const receiptLog = makeLog({ logIndex: 694 });

    await expect(verifyReceiptLogTuple(makeRpc(receiptLog), sourceLog)).resolves.toEqual({ ok: true });
  });

  it("rejects when the independent receipt block hash differs", async () => {
    const log = makeLog();

    await expect(verifyReceiptLogTuple(makeRpc(log, `0x${"d".repeat(64)}` as Hex), log)).resolves.toMatchObject({
      ok: false,
      reason: "RECEIPT_BLOCK_HASH_MISMATCH"
    });
  });

  it("rejects when the exact log tuple is missing from the receipt", async () => {
    const log = makeLog();
    const receiptLog = makeLog({ data: "0x9999" });

    await expect(verifyReceiptLogTuple(makeRpc(receiptLog), log)).resolves.toMatchObject({
      ok: false,
      reason: "RECEIPT_LOG_TUPLE_MISSING"
    });
  });
});
