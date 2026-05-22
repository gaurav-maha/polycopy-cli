import { decodeAbiParameters, getAddress } from "viem";
import { ORDER_FILLED_TOPIC } from "../constants/abi.js";

export type Side = "BUY" | "SELL";

export type RawOrderFilledLog = {
  chainId: 137;
  address: `0x${string}`;
  blockNumber: bigint;
  blockHash: `0x${string}`;
  transactionHash: `0x${string}`;
  transactionIndex: number;
  logIndex: number;
  topics: `0x${string}`[];
  data: `0x${string}`;
};

export type DecodedOrderFilled = {
  chainId: 137;
  contractAddress: `0x${string}`;
  blockNumber: bigint;
  blockHash: `0x${string}`;
  txHash: `0x${string}`;
  txIndex: number;
  logIndex: number;
  orderHash: `0x${string}`;
  maker: `0x${string}`;
  taker: `0x${string}`;
  side: Side;
  tokenId: string;
  makerAmountFilledRaw: string;
  takerAmountFilledRaw: string;
  feeRaw: string;
  builder: `0x${string}`;
  metadata: `0x${string}`;
  pricePpm: string;
};

function topicAddress(topic: `0x${string}`): `0x${string}` {
  return getAddress(`0x${topic.slice(-40)}`) as `0x${string}`;
}

function computePricePpm(side: Side, makerAmount: bigint, takerAmount: bigint): string {
  if (makerAmount <= 0n || takerAmount <= 0n) {
    throw new Error("OrderFilled has nonzero denominator requirements");
  }
  return side === "BUY"
    ? ((makerAmount * 1_000_000n) / takerAmount).toString()
    : ((takerAmount * 1_000_000n) / makerAmount).toString();
}

export function decodeOrderFilledLog(log: RawOrderFilledLog): DecodedOrderFilled {
  if (log.topics.length !== 4) {
    throw new Error(`OrderFilled requires 4 topics, received ${log.topics.length}`);
  }
  if (log.topics[0]?.toLowerCase() !== ORDER_FILLED_TOPIC.toLowerCase()) {
    throw new Error("OrderFilled topic0 mismatch");
  }
  if (log.data.length !== 2 + 64 * 7) {
    throw new Error("OrderFilled data must contain exactly 7 ABI words");
  }
  const [sideValue, tokenId, makerAmountFilled, takerAmountFilled, fee, builder, metadata] = decodeAbiParameters(
    [
      { name: "side", type: "uint8" },
      { name: "tokenId", type: "uint256" },
      { name: "makerAmountFilled", type: "uint256" },
      { name: "takerAmountFilled", type: "uint256" },
      { name: "fee", type: "uint256" },
      { name: "builder", type: "bytes32" },
      { name: "metadata", type: "bytes32" }
    ],
    log.data
  );
  if (sideValue !== 0 && sideValue !== 1) {
    throw new Error(`unsupported OrderFilled side ${sideValue}`);
  }
  const side = sideValue === 0 ? "BUY" : "SELL";
  return {
    chainId: log.chainId,
    contractAddress: getAddress(log.address) as `0x${string}`,
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    txHash: log.transactionHash,
    txIndex: log.transactionIndex,
    logIndex: log.logIndex,
    orderHash: log.topics[1] as `0x${string}`,
    maker: topicAddress(log.topics[2] as `0x${string}`),
    taker: topicAddress(log.topics[3] as `0x${string}`),
    side,
    tokenId: tokenId.toString(),
    makerAmountFilledRaw: makerAmountFilled.toString(),
    takerAmountFilledRaw: takerAmountFilled.toString(),
    feeRaw: fee.toString(),
    builder,
    metadata,
    pricePpm: computePricePpm(side, makerAmountFilled, takerAmountFilled)
  };
}
