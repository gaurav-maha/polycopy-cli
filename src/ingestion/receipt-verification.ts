import type { ChainLog, RpcAdapter } from "../adapters/types.js";
import type { SqliteDatabase } from "../db/client.js";
import { rpcQuantityToNumber, type RpcQuantity } from "./rpc-quantity.js";

export type ReceiptLogVerificationResult =
  | { ok: true }
  | {
      ok: false;
      reason: "RECEIPT_BLOCK_HASH_MISMATCH" | "RECEIPT_LOG_TUPLE_MISSING";
      details: Record<string, unknown>;
    };

function sameHex(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function sameTopics(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((topic, index) => sameHex(topic, b[index] ?? ""));
}

function sameLogTuple(a: ChainLog, b: ChainLog): boolean {
  return (
    sameHex(a.address, b.address) &&
    sameHex(a.transactionHash, b.transactionHash) &&
    rpcQuantityToNumber(a.logIndex as RpcQuantity, "receipt logIndex") ===
      rpcQuantityToNumber(b.logIndex as RpcQuantity, "source logIndex") &&
    sameHex(a.data, b.data) &&
    sameTopics(a.topics, b.topics)
  );
}

export async function verifyReceiptLogTuple(
  rpc: RpcAdapter,
  sourceLog: ChainLog
): Promise<ReceiptLogVerificationResult> {
  const receipt = await rpc.getTransactionReceipt(sourceLog.transactionHash);
  if (!sameHex(receipt.blockHash, sourceLog.blockHash)) {
    return {
      ok: false,
      reason: "RECEIPT_BLOCK_HASH_MISMATCH",
      details: {
        txHash: sourceLog.transactionHash,
        sourceBlockHash: sourceLog.blockHash,
        receiptBlockHash: receipt.blockHash
      }
    };
  }
  const matched = receipt.logs.some((receiptLog) => sameLogTuple(receiptLog, sourceLog));
  if (!matched) {
    return {
      ok: false,
      reason: "RECEIPT_LOG_TUPLE_MISSING",
      details: {
        txHash: sourceLog.transactionHash,
        logIndex: sourceLog.logIndex,
        address: sourceLog.address
      }
    };
  }
  return { ok: true };
}

function parseStoredChainLog(rawLogJson: string): ChainLog {
  const raw = JSON.parse(rawLogJson) as Omit<ChainLog, "blockNumber" | "transactionIndex" | "logIndex"> & {
    blockNumber: string | number | bigint;
    transactionIndex?: RpcQuantity;
    logIndex: RpcQuantity;
  };
  return {
    ...raw,
    blockNumber: BigInt(raw.blockNumber),
    transactionIndex: rpcQuantityToNumber(raw.transactionIndex ?? 0, "transactionIndex"),
    logIndex: rpcQuantityToNumber(raw.logIndex, "logIndex")
  };
}

export async function verifyGroupSourceFillReceipts(
  db: SqliteDatabase,
  rpc: RpcAdapter,
  sourceFillIds: readonly string[]
): Promise<ReceiptLogVerificationResult> {
  for (const sourceFillId of sourceFillIds) {
    const row = db.prepare("SELECT raw_log_json FROM source_fills WHERE id = ?").get(sourceFillId) as
      | { raw_log_json: string }
      | undefined;
    if (!row) {
      return {
        ok: false,
        reason: "RECEIPT_LOG_TUPLE_MISSING",
        details: { sourceFillId }
      };
    }
    const verified = await verifyReceiptLogTuple(rpc, parseStoredChainLog(row.raw_log_json));
    if (!verified.ok) return verified;
  }
  return { ok: true };
}
