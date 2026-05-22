import { createPublicClient, webSocket } from "viem";
import { polygon } from "viem/chains";
import type { BlockHeadAdapter, Hex, LogSubscriptionAdapter } from "../adapters/types.js";
import { ORDER_FILLED_EVENT_ABI } from "../constants/abi.js";
import { chainLogFromViem } from "./log-utils.js";

export function createAlchemyLogSubscription(wsUrl: string): LogSubscriptionAdapter {
  return {
    async subscribeOrderFilled({ leaders, exchangeAddresses, onLog }) {
      const client = createManagedWsClient(wsUrl, "polycopy-logs");
      const closeClient = () => closeManagedWsClient(client);
      const subscriptions = leaders.flatMap((leader) => [{ maker: leader }, { taker: leader }]);
      const unwatchers = await Promise.all(
        subscriptions.map((filter) =>
          client.watchContractEvent({
            address: exchangeAddresses,
            abi: [ORDER_FILLED_EVENT_ABI],
            eventName: "OrderFilled",
            args: filter,
            onLogs: (logs) => {
              for (const log of logs) {
                void onLog(chainLogFromViem(log));
              }
            }
          })
        )
      );
      return () => {
        for (const unwatch of unwatchers) {
          unwatch();
        }
        closeClient();
      };
    }
  };
}

export function createAlchemyBlockHeadSubscription(wsUrl: string): BlockHeadAdapter {
  return {
    async watchBlockHead(onHead) {
      const client = createManagedWsClient(wsUrl, "polycopy-heads");
      const unwatch = client.watchBlocks({
        onBlock: (block) => {
          if (block.hash === null) return;
          onHead({
            number: block.number,
            hash: block.hash as Hex,
            timestampMs: Number(block.timestamp * 1_000n)
          });
        }
      });
      return () => {
        unwatch();
        closeManagedWsClient(client);
      };
    }
  };
}

function createManagedWsClient(wsUrl: string, key: string) {
  return createPublicClient({
    chain: polygon,
    transport: webSocket(wsUrl, { key, reconnect: false })
  });
}

function closeManagedWsClient(client: ReturnType<typeof createManagedWsClient>): void {
  void client.transport
    .getRpcClient()
    .then((rpcClient) => rpcClient.close())
    .catch(() => undefined);
}

export function createAlchemyWsAdapters(wsUrl: string): {
  logs: LogSubscriptionAdapter;
  blockHead: BlockHeadAdapter;
} {
  return {
    logs: createAlchemyLogSubscription(wsUrl),
    blockHead: createAlchemyBlockHeadSubscription(wsUrl)
  };
}
