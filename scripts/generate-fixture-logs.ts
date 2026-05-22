import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { encodeAbiParameters, encodeEventTopics, getAddress, toHex } from "viem";
import { CTF_EXCHANGE_V2, NEG_RISK_CTF_EXCHANGE_V2 } from "../src/constants/chain.js";
import { ORDER_FILLED_EVENT_ABI } from "../src/constants/abi.js";

const LEADER = "0x1111111111111111111111111111111111111111" as const;
const EXCHANGE = CTF_EXCHANGE_V2;
const NEG_RISK_EXCHANGE = NEG_RISK_CTF_EXCHANGE_V2;
const CTF = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045" as const;

type FixtureSpec = {
  filename: string;
  txHash: `0x${string}`;
  blockNumber: number;
  blockHash: `0x${string}`;
  contractAddress: `0x${string}`;
  transactionIndex: number;
  logIndex: number;
  orderHash: `0x${string}`;
  maker: `0x${string}`;
  taker: `0x${string}`;
  side: 0 | 1;
  tokenId: bigint;
  makerAmountFilled: bigint;
  takerAmountFilled: bigint;
  fee?: bigint;
  dataOverride?: `0x${string}`;
  topic0Override?: `0x${string}`;
};

function encodeData(args: Omit<FixtureSpec, "filename" | "txHash" | "blockNumber" | "blockHash" | "contractAddress" | "transactionIndex" | "logIndex">): `0x${string}` {
  if (args.dataOverride) return args.dataOverride;
  return encodeAbiParameters(
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
      args.side,
      args.tokenId,
      args.makerAmountFilled,
      args.takerAmountFilled,
      args.fee ?? 0n,
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      "0x0000000000000000000000000000000000000000000000000000000000000000"
    ]
  );
}

function buildLog(spec: FixtureSpec) {
  const topics = encodeEventTopics({
    abi: [ORDER_FILLED_EVENT_ABI],
    eventName: "OrderFilled",
    args: {
      orderHash: spec.orderHash,
      maker: spec.maker,
      taker: spec.taker
    }
  }) as `0x${string}`[];
  if (spec.topic0Override) topics[0] = spec.topic0Override;
  return {
    address: getAddress(spec.contractAddress),
    blockHash: spec.blockHash,
    blockNumber: toHex(spec.blockNumber),
    transactionHash: spec.txHash,
    transactionIndex: toHex(spec.transactionIndex),
    logIndex: toHex(spec.logIndex),
    removed: false,
    topics,
    data: encodeData(spec)
  };
}

const specs: FixtureSpec[] = [
  {
    filename: "accepted-taker-buy.json",
    txHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    blockNumber: 100,
    blockHash: "0x0101010101010101010101010101010101010101010101010101010101010101",
    contractAddress: EXCHANGE,
    transactionIndex: 0,
    logIndex: 0,
    orderHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    maker: LEADER,
    taker: EXCHANGE,
    side: 0,
    tokenId: 100000000000000000001n,
    makerAmountFilled: 620000n,
    takerAmountFilled: 1000000n
  },
  {
    filename: "accepted-taker-sell.json",
    txHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    blockNumber: 101,
    blockHash: "0x0202020202020202020202020202020202020202020202020202020202020202",
    contractAddress: EXCHANGE,
    transactionIndex: 1,
    logIndex: 0,
    orderHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    maker: LEADER,
    taker: EXCHANGE,
    side: 1,
    tokenId: 100000000000000000002n,
    makerAmountFilled: 1000000n,
    takerAmountFilled: 430000n
  },
  {
    filename: "nonzero-fee-buy.json",
    txHash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    blockNumber: 102,
    blockHash: "0x0303030303030303030303030303030303030303030303030303030303030303",
    contractAddress: EXCHANGE,
    transactionIndex: 2,
    logIndex: 0,
    orderHash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    maker: LEADER,
    taker: EXCHANGE,
    side: 0,
    tokenId: 100000000000000000003n,
    makerAmountFilled: 555000n,
    takerAmountFilled: 1000000n,
    fee: 1250n
  },
  {
    filename: "maker-side-skip.json",
    txHash: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    blockNumber: 103,
    blockHash: "0x0404040404040404040404040404040404040404040404040404040404040404",
    contractAddress: EXCHANGE,
    transactionIndex: 3,
    logIndex: 0,
    orderHash: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    maker: "0x5555555555555555555555555555555555555555",
    taker: LEADER,
    side: 0,
    tokenId: 100000000000000000004n,
    makerAmountFilled: 700000n,
    takerAmountFilled: 1000000n
  },
  {
    filename: "multi-fill-grouping-a.json",
    txHash: "0xf1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1",
    blockNumber: 105,
    blockHash: "0x0606060606060606060606060606060606060606060606060606060606060606",
    contractAddress: EXCHANGE,
    transactionIndex: 5,
    logIndex: 0,
    orderHash: "0xf1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1",
    maker: LEADER,
    taker: EXCHANGE,
    side: 0,
    tokenId: 100000000000000000005n,
    makerAmountFilled: 250000n,
    takerAmountFilled: 500000n
  },
  {
    filename: "multi-fill-grouping-b.json",
    txHash: "0xf2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2",
    blockNumber: 106,
    blockHash: "0x0707070707070707070707070707070707070707070707070707070707070707",
    contractAddress: EXCHANGE,
    transactionIndex: 0,
    logIndex: 1,
    orderHash: "0xf2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2",
    maker: LEADER,
    taker: EXCHANGE,
    side: 0,
    tokenId: 100000000000000000005n,
    makerAmountFilled: 250000n,
    takerAmountFilled: 500000n
  },
  {
    filename: "ambiguous-asset-skip.json",
    txHash: "0x8888888888888888888888888888888888888888888888888888888888888888",
    blockNumber: 107,
    blockHash: "0x0808080808080808080808080808080808080808080808080808080808080808",
    contractAddress: EXCHANGE,
    transactionIndex: 1,
    logIndex: 0,
    orderHash: "0x8888888888888888888888888888888888888888888888888888888888888888",
    maker: LEADER,
    taker: "0x7777777777777777777777777777777777777777",
    side: 0,
    tokenId: 0n,
    makerAmountFilled: 500000n,
    takerAmountFilled: 1000000n
  },
  {
    filename: "stale-v1-rejection.json",
    txHash: "0x9999999999999999999999999999999999999999999999999999999999999999",
    blockNumber: 108,
    blockHash: "0x0909090909090909090909090909090909090909090909090909090909090909",
    contractAddress: EXCHANGE,
    transactionIndex: 2,
    logIndex: 0,
    orderHash: "0x9999999999999999999999999999999999999999999999999999999999999999",
    maker: LEADER,
    taker: EXCHANGE,
    side: 0,
    tokenId: 100000000000000000006n,
    makerAmountFilled: 640000n,
    takerAmountFilled: 1000000n,
    dataOverride: "0x00"
  },
  {
    filename: "ws-book-gap-fault.json",
    txHash: "0xabababababababababababababababababababababababababababababababab",
    blockNumber: 109,
    blockHash: "0x1010101010101010101010101010101010101010101010101010101010101010",
    contractAddress: EXCHANGE,
    transactionIndex: 3,
    logIndex: 0,
    orderHash: "0xabababababababababababababababababababababababababababababababab",
    maker: LEADER,
    taker: EXCHANGE,
    side: 0,
    tokenId: 100000000000000000007n,
    makerAmountFilled: 520000n,
    takerAmountFilled: 1000000n
  }
];

async function main(): Promise<void> {
  const outDir = resolve("fixtures/logs");
  await mkdir(outDir, { recursive: true });
  for (const spec of specs) {
    await writeFile(resolve(outDir, spec.filename), `${JSON.stringify(buildLog(spec), null, 2)}\n`);
  }

  const mintMerge = {
    address: getAddress(CTF),
    blockHash: "0x0505050505050505050505050505050505050505050505050505050505050505",
    blockNumber: toHex(104),
    transactionHash: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    transactionIndex: toHex(4),
    logIndex: toHex(0),
    removed: false,
    topics: [
      "0x4c209b5fc8ad507a7d03d2917a822963547108df3e854675b8bc4a1b2b91389",
      "0x0000000000000000000000001111111111111111111111111111111111111111"
    ],
    data: "0x"
  };
  await writeFile(resolve(outDir, "mint-merge-skip.json"), `${JSON.stringify(mintMerge, null, 2)}\n`);

  const rpcDisagreement = {
    txHash: "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
    blockNumber: 110,
    blockHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
    contractAddress: EXCHANGE,
    transactionIndex: 4,
    logIndex: 0,
    fault: "RPC_LOG_DISAGREEMENT"
  };
  await writeFile(resolve(outDir, "rpc-disagreement-fault.json"), `${JSON.stringify(rpcDisagreement, null, 2)}\n`);

  void NEG_RISK_EXCHANGE;
}

await main();
