import { createPublicClient, encodeEventTopics, getAddress, http, numberToHex, type Log } from "viem";
import { polygon } from "viem/chains";
import type { ChainLog, Hex, RpcAdapter, RpcLogTopic } from "../adapters/types.js";
import { CTF_EXCHANGE_V2, NEG_RISK_CTF_EXCHANGE_V2 } from "../constants/chain.js";
import { ORDER_FILLED_EVENT_ABI } from "../constants/abi.js";
import { chainLogFromViem, toRawOrderFilledLog } from "./log-utils.js";
import { ingestRawLog } from "./pending-fills.js";

export function createHttpRpcAdapter(rpcUrl: string): RpcAdapter {
  const client = createPublicClient({ chain: polygon, transport: http(rpcUrl) });
  return {
    async getChainId() {
      const id = await client.getChainId();
      if (id !== 137) throw new Error(`Unexpected chain id ${id}`);
      return 137;
    },
    async getLatestBlock() {
      const block = await client.getBlock({ blockTag: "latest" });
      if (block.hash === null) throw new Error("Latest block missing hash");
      return { number: block.number, hash: block.hash as Hex, timestampMs: Number(block.timestamp * 1_000n) };
    },
    async getBlock(number: bigint) {
      const block = await client.getBlock({ blockNumber: number });
      if (block.hash === null) throw new Error(`Block ${number} missing hash`);
      return { number: block.number, hash: block.hash as Hex, timestampMs: Number(block.timestamp * 1_000n) };
    },
    async getCode(args) {
      return (await client.getBytecode({
        address: args.address,
        blockNumber: args.blockTag === "latest" ? undefined : args.blockTag
      })) ?? ("0x" as Hex);
    },
    async getLogs(args) {
      const logs = (await client.request({
        method: "eth_getLogs",
        params: [
          {
            address: args.addresses,
            fromBlock: numberToHex(args.fromBlock),
            toBlock: numberToHex(args.toBlock),
            topics: args.topics
          }
        ]
      })) as Log[];
      return logs.map(chainLogFromViem);
    },
    async getTransactionReceipt(txHash) {
      const receipt = await client.getTransactionReceipt({ hash: txHash });
      return {
        blockHash: receipt.blockHash as Hex,
        logs: receipt.logs.map(chainLogFromViem)
      };
    },
    async readContract<T>(args: {
      address: Hex;
      abi: unknown;
      functionName: string;
      args?: unknown[];
      blockTag?: bigint | "latest";
    }): Promise<T> {
      return client.readContract({
        address: args.address,
        abi: args.abi as readonly unknown[],
        functionName: args.functionName,
        args: args.args as readonly unknown[] | undefined,
        blockNumber: args.blockTag === "latest" ? undefined : args.blockTag
      }) as Promise<T>;
    }
  };
}

export async function catchUpLogs(args: {
  rpc: RpcAdapter;
  db: Parameters<typeof ingestRawLog>[0];
  leaders: Hex[];
  fromBlock: bigint;
  toBlock: bigint;
}): Promise<number> {
  if (args.fromBlock > args.toBlock || args.leaders.length === 0) return 0;

  const allLogs = new Map<string, ChainLog>();
  for (const leader of args.leaders) {
    const normalizedLeader = getAddress(leader);
    for (const topics of [
      orderFilledTopics({ maker: normalizedLeader }),
      orderFilledTopics({ taker: normalizedLeader })
    ]) {
      const logs = await args.rpc.getLogs({
        fromBlock: args.fromBlock,
        toBlock: args.toBlock,
        addresses: [CTF_EXCHANGE_V2, NEG_RISK_CTF_EXCHANGE_V2],
        topics
      });
      for (const log of logs) {
        allLogs.set(logKey(log), log);
      }
    }
  }

  let inserted = 0;
  for (const chainLog of [...allLogs.values()].sort(
    (a, b) => Number(a.blockNumber - b.blockNumber) || a.transactionIndex - b.transactionIndex || a.logIndex - b.logIndex
  )) {
    const block = await args.rpc.getBlock(chainLog.blockNumber);
    const raw = toRawOrderFilledLog(chainLog);
    const result = ingestRawLog(args.db, raw, block.timestampMs);
    if (result.inserted) inserted += 1;
  }
  return inserted;
}

function orderFilledTopics(args: { maker?: Hex; taker?: Hex }): RpcLogTopic[] {
  return encodeEventTopics({
    abi: [ORDER_FILLED_EVENT_ABI],
    eventName: "OrderFilled",
    args
  }) as RpcLogTopic[];
}

function logKey(log: ChainLog): string {
  return `${log.chainId}|${log.address.toLowerCase()}|${log.blockHash.toLowerCase()}|${log.transactionHash.toLowerCase()}|${log.logIndex}`;
}
