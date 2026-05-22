import type { Log } from "viem";
import { getAddress } from "viem";
import type { ChainLog, Hex } from "../adapters/types.js";
import type { RawOrderFilledLog } from "../protocol/decode-order-filled.js";
import { rpcQuantityToNumber } from "./rpc-quantity.js";

export function chainLogFromViem(log: Log): ChainLog {
  if (log.blockNumber === null || log.blockHash === null || log.transactionHash === null || log.logIndex === null) {
    throw new Error("RPC log is missing mined log fields");
  }
  return {
    chainId: 137,
    address: getAddress(log.address) as Hex,
    blockNumber: log.blockNumber,
    blockHash: log.blockHash as Hex,
    transactionHash: log.transactionHash as Hex,
    transactionIndex: rpcQuantityToNumber(log.transactionIndex ?? 0, "transactionIndex"),
    logIndex: rpcQuantityToNumber(log.logIndex, "logIndex"),
    topics: [...log.topics] as Hex[],
    data: log.data as Hex
  };
}

export function toRawOrderFilledLog(log: ChainLog): RawOrderFilledLog {
  return {
    chainId: 137,
    address: log.address,
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    transactionHash: log.transactionHash,
    transactionIndex: log.transactionIndex,
    logIndex: log.logIndex,
    topics: log.topics,
    data: log.data
  };
}
