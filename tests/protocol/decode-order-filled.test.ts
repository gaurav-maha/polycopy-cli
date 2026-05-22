import { encodeEventTopics, encodeAbiParameters, getAddress } from "viem";
import {
  CTF_EXCHANGE_V2,
  NEG_RISK_CTF_EXCHANGE_V2,
  ORDER_FILLED_EVENT_ABI,
  ORDER_FILLED_TOPIC,
  ORDER_TYPEHASH
} from "../../src/constants/abi.js";
import { decodeOrderFilledLog } from "../../src/protocol/decode-order-filled.js";
import { normalizeSourceFill } from "../../src/normalize/taker-filter.js";

const leader = "0x9d84ce0306f8551e02efef1680475fc0f1dc1344";
const taker = CTF_EXCHANGE_V2;
const counterparty = "0x1111111111111111111111111111111111111111";
const orderHash = "0x1111111111111111111111111111111111111111111111111111111111111111";

function makeOrderFilledLog(args: {
  side: 0 | 1;
  makerAmountFilled: bigint;
  takerAmountFilled: bigint;
  fee?: bigint;
  maker?: `0x${string}`;
  taker?: `0x${string}`;
  address?: `0x${string}`;
}) {
  const topics = encodeEventTopics({
    abi: [ORDER_FILLED_EVENT_ABI],
    eventName: "OrderFilled",
    args: {
      orderHash,
      maker: args.maker ?? leader,
      taker: args.taker ?? taker
    }
  }) as `0x${string}`[];
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
      args.side,
      123456789n,
      args.makerAmountFilled,
      args.takerAmountFilled,
      args.fee ?? 0n,
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      "0x2222222222222222222222222222222222222222222222222222222222222222"
    ]
  );
  return {
    chainId: 137 as const,
    address: args.address ?? CTF_EXCHANGE_V2,
    blockNumber: 100n,
    blockHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`,
    transactionHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as `0x${string}`,
    transactionIndex: 1,
    logIndex: 2,
    topics,
    data
  };
}

describe("V2 OrderFilled decoder", () => {
  it("pins the exact order typehash and event topic", () => {
    expect(ORDER_TYPEHASH).toBe("0xbb86318a2138f5fa8ae32fbe8e659f8fcf13cc6ae4014a707893055433818589");
    expect(ORDER_FILLED_TOPIC).toBe(
      "0xd543adfd945773f1a62f74f0ee55a5e3b9b1a28262980ba90b1a89f2ea84d8ee"
    );
  });

  it("decodes a taker aggregate BUY and computes leader PPM from maker/taker amounts", () => {
    const decoded = decodeOrderFilledLog(makeOrderFilledLog({ side: 0, makerAmountFilled: 400000n, takerAmountFilled: 1000000n }));
    expect(decoded).toMatchObject({
      maker: getAddress(leader),
      taker,
      side: "BUY",
      tokenId: "123456789",
      makerAmountFilledRaw: "400000",
      takerAmountFilledRaw: "1000000",
      feeRaw: "0",
      pricePpm: "400000"
    });

    const normalized = normalizeSourceFill(decoded, { sourceWallets: [leader], exchangeAddresses: [CTF_EXCHANGE_V2, NEG_RISK_CTF_EXCHANGE_V2] });
    expect(normalized).toMatchObject({
      accepted: true,
      side: "BUY",
      filledNotionalRaw: "400000",
      budgetImpactRaw: "400000",
      tokenDeltaRaw: "1000000"
    });
  });

  it("accepts a leader maker fill even when the taker is another user", () => {
    const decoded = decodeOrderFilledLog(
      makeOrderFilledLog({
        side: 0,
        makerAmountFilled: 400000n,
        takerAmountFilled: 1000000n,
        maker: leader,
        taker: counterparty
      })
    );

    const normalized = normalizeSourceFill(decoded, { sourceWallets: [leader], exchangeAddresses: [CTF_EXCHANGE_V2, NEG_RISK_CTF_EXCHANGE_V2] });
    expect(normalized).toMatchObject({
      accepted: true,
      sourceWallet: getAddress(leader),
      leaderRole: "MAKER",
      side: "BUY",
      filledNotionalRaw: "400000",
      budgetImpactRaw: "400000",
      tokenDeltaRaw: "1000000"
    });
  });

  it("normalizes a leader taker fill by inverting the maker side and economics", () => {
    const decoded = decodeOrderFilledLog(
      makeOrderFilledLog({
        side: 0,
        makerAmountFilled: 400000n,
        takerAmountFilled: 1000000n,
        fee: 500n,
        maker: counterparty,
        taker: leader
      })
    );

    const normalized = normalizeSourceFill(decoded, { sourceWallets: [leader], exchangeAddresses: [CTF_EXCHANGE_V2, NEG_RISK_CTF_EXCHANGE_V2] });
    expect(normalized).toMatchObject({
      accepted: true,
      sourceWallet: getAddress(leader),
      leaderRole: "TAKER",
      side: "SELL",
      feeRaw: "0",
      filledNotionalRaw: "400000",
      proceedsRaw: "400000",
      budgetImpactRaw: "0",
      inventoryDeltaRaw: "1000000"
    });
  });

  it("skips a fill when both maker and taker are configured leaders", () => {
    const decoded = decodeOrderFilledLog(
      makeOrderFilledLog({
        side: 0,
        makerAmountFilled: 400000n,
        takerAmountFilled: 1000000n,
        maker: leader,
        taker: counterparty
      })
    );

    const normalized = normalizeSourceFill(decoded, {
      sourceWallets: [leader, counterparty],
      exchangeAddresses: [CTF_EXCHANGE_V2, NEG_RISK_CTF_EXCHANGE_V2]
    });

    expect(normalized).toMatchObject({ accepted: false, skipReason: "ROLE_AMBIGUOUS" });
    expect(normalized.sourceWallet).toBeUndefined();
  });

  it("skips a sell fill when both maker and taker are configured leaders", () => {
    const decoded = decodeOrderFilledLog(
      makeOrderFilledLog({
        side: 1,
        makerAmountFilled: 1000000n,
        takerAmountFilled: 400000n,
        maker: leader,
        taker: counterparty
      })
    );

    const normalized = normalizeSourceFill(decoded, {
      sourceWallets: [leader, counterparty],
      exchangeAddresses: [CTF_EXCHANGE_V2, NEG_RISK_CTF_EXCHANGE_V2]
    });

    expect(normalized).toMatchObject({ accepted: false, skipReason: "ROLE_AMBIGUOUS" });
    expect(normalized.sourceWallet).toBeUndefined();
  });

  it("decodes a taker aggregate SELL with nonzero fee", () => {
    const decoded = decodeOrderFilledLog(
      makeOrderFilledLog({ side: 1, makerAmountFilled: 500000n, takerAmountFilled: 300000n, fee: 1000n })
    );
    expect(decoded).toMatchObject({
      side: "SELL",
      pricePpm: "600000",
      feeRaw: "1000"
    });

    const normalized = normalizeSourceFill(decoded, { sourceWallets: [leader], exchangeAddresses: [CTF_EXCHANGE_V2, NEG_RISK_CTF_EXCHANGE_V2] });
    expect(normalized).toMatchObject({
      accepted: true,
      filledNotionalRaw: "300000",
      proceedsRaw: "299000",
      budgetImpactRaw: "0",
      inventoryDeltaRaw: "500000"
    });
  });

  it("rejects stale V1-shaped logs with the wrong data length", () => {
    const log = makeOrderFilledLog({ side: 0, makerAmountFilled: 1n, takerAmountFilled: 2n });
    expect(() => decodeOrderFilledLog({ ...log, data: "0x00" })).toThrow(/7 ABI words/);
  });

  it("normalizes a leader taker BUY when the maker sold outcome tokens", () => {
    const decoded = decodeOrderFilledLog(
      makeOrderFilledLog({ side: 0, makerAmountFilled: 1n, takerAmountFilled: 2n, maker: counterparty, taker: leader })
    );
    const normalized = normalizeSourceFill(decoded, { sourceWallets: [leader], exchangeAddresses: [CTF_EXCHANGE_V2, NEG_RISK_CTF_EXCHANGE_V2] });
    expect(normalized).toMatchObject({ accepted: true, leaderRole: "TAKER", side: "SELL" });
  });

  it("rejects token id zero as an invalid V2 outcome token", () => {
    const log = makeOrderFilledLog({ side: 0, makerAmountFilled: 1n, takerAmountFilled: 2n });
    const decoded = decodeOrderFilledLog({
      ...log,
      data: encodeAbiParameters(
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
          0n,
          1n,
          2n,
          0n,
          "0x0000000000000000000000000000000000000000000000000000000000000000",
          "0x2222222222222222222222222222222222222222222222222222222222222222"
        ]
      )
    });
    const normalized = normalizeSourceFill(decoded, { sourceWallets: [leader], exchangeAddresses: [CTF_EXCHANGE_V2, NEG_RISK_CTF_EXCHANGE_V2] });
    expect(normalized).toMatchObject({ accepted: false, skipReason: "ERROR", errorReason: "INVALID_TOKEN_ID" });
  });
});
