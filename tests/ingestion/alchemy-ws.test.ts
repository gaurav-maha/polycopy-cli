import { beforeEach, describe, expect, it, vi } from "vitest";

const closeRpcClient = vi.fn();
const getRpcClient = vi.fn(async () => ({ close: closeRpcClient }));
const unwatchBlocks = vi.fn();
const watchBlocks = vi.fn(() => unwatchBlocks);
const unwatchEvent = vi.fn();
const watchContractEvent = vi.fn(() => unwatchEvent);
const createPublicClient = vi.fn(() => ({
  transport: { getRpcClient },
  watchBlocks,
  watchContractEvent
}));
const webSocket = vi.fn((url: string, config?: unknown) => ({ url, config }));

vi.mock("viem", async (importOriginal) => ({
  ...(await importOriginal<typeof import("viem")>()),
  createPublicClient,
  webSocket
}));

vi.mock("viem/chains", () => ({
  polygon: { id: 137, name: "Polygon" }
}));

describe("Alchemy websocket subscriptions", () => {
  beforeEach(() => {
    closeRpcClient.mockClear();
    getRpcClient.mockClear();
    unwatchBlocks.mockClear();
    unwatchEvent.mockClear();
    watchBlocks.mockClear();
    watchContractEvent.mockClear();
    createPublicClient.mockClear();
    webSocket.mockClear();
  });

  it("closes the websocket client when block watching is stopped", async () => {
    const { createAlchemyBlockHeadSubscription } = await import("../../src/ingestion/alchemy-ws.js");

    const unwatch = await createAlchemyBlockHeadSubscription("wss://polygon.example/ws").watchBlockHead(() => {});
    unwatch();
    await Promise.resolve();

    expect(unwatchBlocks).toHaveBeenCalledTimes(1);
    expect(getRpcClient).toHaveBeenCalledTimes(1);
    expect(closeRpcClient).toHaveBeenCalledTimes(1);
    expect(webSocket).toHaveBeenCalledWith(
      "wss://polygon.example/ws",
      expect.objectContaining({ reconnect: false })
    );
  });

  it("subscribes to both maker and taker OrderFilled filters for each leader", async () => {
    const { createAlchemyLogSubscription } = await import("../../src/ingestion/alchemy-ws.js");

    const unwatch = await createAlchemyLogSubscription("wss://polygon.example/ws").subscribeOrderFilled({
      leaders: [
        "0x9d84ce0306f8551e02efef1680475fc0f1dc1344",
        "0x1111111111111111111111111111111111111111"
      ],
      exchangeAddresses: ["0x2222222222222222222222222222222222222222"],
      onLog: () => undefined
    });
    unwatch();
    await Promise.resolve();

    expect(watchContractEvent).toHaveBeenCalledTimes(4);
    expect(watchContractEvent).toHaveBeenCalledWith(expect.objectContaining({ args: { maker: expect.any(String) } }));
    expect(watchContractEvent).toHaveBeenCalledWith(expect.objectContaining({ args: { taker: expect.any(String) } }));
    expect(unwatchEvent).toHaveBeenCalledTimes(4);
    expect(closeRpcClient).toHaveBeenCalledTimes(1);
  });
});
