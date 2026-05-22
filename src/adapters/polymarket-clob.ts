import {
  AssetType,
  Chain,
  ClobClient,
  OrderType,
  Side,
  SignatureTypeV2,
  type ApiKeyCreds,
  type SignedOrder
} from "@polymarket/clob-client-v2";
import { createWalletClient, hashTypedData, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import type {
  CancelResult,
  ClobBalanceAllowanceSnapshot,
  ClobRestAdapter,
  MarketMetadata,
  OrderBookSnapshot,
  OrderStatusResult,
  SignedClobOrder,
  SubmitResult
} from "./types.js";
import { CTF_EXCHANGE_V2, NEG_RISK_CTF_EXCHANGE_V2 } from "../constants/chain.js";
import type { LiveOrderSigner } from "../execution/live-runner.js";

const clobHost = "https://clob.polymarket.com";
const zeroBytes32 = `0x${"0".repeat(64)}` as const;

const orderTypesV2 = {
  Order: [
    { name: "salt", type: "uint256" },
    { name: "maker", type: "address" },
    { name: "signer", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "makerAmount", type: "uint256" },
    { name: "takerAmount", type: "uint256" },
    { name: "side", type: "uint8" },
    { name: "signatureType", type: "uint8" },
    { name: "timestamp", type: "uint256" },
    { name: "metadata", type: "bytes32" },
    { name: "builder", type: "bytes32" }
  ]
} as const;

export class PolymarketClobAdapter implements ClobRestAdapter, LiveOrderSigner {
  readonly #client: ClobClient;
  readonly #funder: Hex;
  readonly #signatureType: 0 | 1 | 3;

  constructor(args: {
    privateKey: Hex;
    rpcUrl: string;
    creds: ApiKeyCreds;
    signatureType: 0 | 1 | 3;
    funder: Hex;
  }) {
    const account = privateKeyToAccount(args.privateKey);
    const signer = createWalletClient({ account, chain: polygon, transport: http(args.rpcUrl) });
    this.#funder = args.funder;
    this.#signatureType = args.signatureType;
    this.#client = new ClobClient({
      host: clobHost,
      chain: Chain.POLYGON,
      signer: signer as never,
      creds: args.creds,
      signatureType: toSdkSignatureType(args.signatureType),
      funderAddress: args.funder
    });
  }

  async signMarketOrder(args: {
    tokenId: string;
    side: "BUY" | "SELL";
    approvedNotionalRaw: bigint;
    intendedSizeRaw: bigint;
    limitPricePpm: number;
    orderType: "FAK" | "FOK";
    tickSize: string;
    negRisk: boolean;
    userPusdBalanceRaw?: bigint;
  }): Promise<SignedClobOrder> {
    const payload = await this.#client.createMarketOrder(
      {
        tokenID: args.tokenId,
        amount: rawAmountToDecimal(args.side === "BUY" ? args.approvedNotionalRaw : args.intendedSizeRaw),
        price: args.limitPricePpm / 1_000_000,
        side: args.side === "BUY" ? Side.BUY : Side.SELL,
        orderType: args.orderType === "FAK" ? OrderType.FAK : OrderType.FOK,
        userUSDCBalance: args.userPusdBalanceRaw === undefined ? undefined : rawAmountToDecimal(args.userPusdBalanceRaw),
        builderCode: zeroBytes32
      },
      {
        tickSize: args.tickSize as "0.1" | "0.01" | "0.001" | "0.0001",
        negRisk: args.negRisk
      }
    );
    return {
      orderHash: hashSignedOrderV2(payload, args.negRisk),
      payload
    };
  }

  async getMarket(tokenId: string): Promise<MarketMetadata> {
    const [raw, tickSize, negRisk, feeExponent] = await Promise.all([
      this.#client.getOrderBook(tokenId) as Promise<{
        min_order_size?: string;
        tick_size?: string;
        neg_risk?: boolean;
      }>,
      this.#client.getTickSize(tokenId),
      this.#client.getNegRisk(tokenId),
      this.#client.getFeeExponent(tokenId)
    ]);
    const feeInfo = this.#client.feeInfos[tokenId] ?? { rate: 0, exponent: feeExponent };
    const resolvedTickSize = raw.tick_size ?? String(tickSize);
    return {
      tokenId,
      source: "REST",
      receivedAtMs: Date.now(),
      conditionId: `0x${"0".repeat(64)}`,
      outcome: "",
      negRisk: raw.neg_risk ?? negRisk,
      active: true,
      resolved: false,
      paused: false,
      tickSize: resolvedTickSize,
      tickSizePpm: Math.round(Number.parseFloat(resolvedTickSize) * 1_000_000),
      minOrderSizeSharesDecimal: raw.min_order_size ?? "0",
      feeConfig: { r: String(feeInfo.rate), e: String(feeInfo.exponent), to: `0x${"0".repeat(40)}`, raw: { orderBook: raw, feeInfo } }
    };
  }

  async getOrderBook(tokenId: string): Promise<OrderBookSnapshot> {
    const raw = (await this.#client.getOrderBook(tokenId)) as {
      asset_id?: string;
      bids?: Array<{ price: string; size: string }>;
      asks?: Array<{ price: string; size: string }>;
      hash?: string;
    };
    return {
      tokenId,
      source: "REST",
      snapshotId: raw.hash,
      receivedAtMs: Date.now(),
      bids: (raw.bids ?? []).map((level) => ({ pricePpm: decimalPriceToPpm(level.price), sizeRaw: decimalSharesToRaw(level.size) })),
      asks: (raw.asks ?? []).map((level) => ({ pricePpm: decimalPriceToPpm(level.price), sizeRaw: decimalSharesToRaw(level.size) }))
    };
  }

  async getBalanceAllowance(args: {
    assetType: "COLLATERAL" | "CONDITIONAL";
    tokenId?: string;
    expectedFunder: Hex;
    expectedSpender: Hex;
    expectedSignatureType: 0 | 1 | 3;
  }): Promise<ClobBalanceAllowanceSnapshot> {
    if (args.expectedFunder.toLowerCase() !== this.#funder.toLowerCase()) {
      throw new Error("CLOB adapter funder does not match requested balance funder");
    }
    if (args.expectedSignatureType !== this.#signatureType) {
      throw new Error("CLOB adapter signature type does not match requested balance signature type");
    }
    const raw = (await this.#client.getBalanceAllowance({
      asset_type: args.assetType === "COLLATERAL" ? AssetType.COLLATERAL : AssetType.CONDITIONAL,
      token_id: args.tokenId
    })) as { balance?: string; allowances?: Record<string, string> };
    return {
      ...args,
      balanceRaw: raw.balance ?? "0",
      allowanceRaw: readAllowance(raw.allowances ?? {}, args.expectedSpender),
      receivedAtMs: Date.now(),
      raw
    };
  }

  async submitOrder(args: { signedOrder: SignedClobOrder; orderType: "FAK" | "FOK"; postOnly?: false }): Promise<SubmitResult> {
    const raw = await this.#client.postOrder(
      args.signedOrder.payload as SignedOrder,
      args.orderType === "FAK" ? OrderType.FAK : OrderType.FOK,
      false
    );
    return normalizeSubmitResult(raw);
  }

  async getOrderByHash(signedOrderHash: Hex): Promise<OrderStatusResult> {
    const order = await this.#client.getOrder(signedOrderHash).catch(() => null);
    const trades = (await this.#client.getTrades(undefined, true).catch(() => [])) as Array<{
      id: string;
      taker_order_id?: string;
      side: "BUY" | "SELL";
      size: string;
      price: string;
      match_time?: string;
      transaction_hash?: string;
      maker_orders?: Array<{ order_id?: string }>;
    }>;
    const matchingTrades = trades.filter((trade) => {
      if (trade.taker_order_id?.toLowerCase() === signedOrderHash.toLowerCase()) return true;
      return (trade.maker_orders ?? []).some((makerOrder) => makerOrder.order_id?.toLowerCase() === signedOrderHash.toLowerCase());
    });
    if (matchingTrades.length > 0) {
      return {
        status: "matched",
        fills: matchingTrades.map((trade) => tradeToFill(signedOrderHash, trade)),
        raw: { order, trades: matchingTrades }
      };
    }
    if (order && typeof order === "object" && "status" in order) {
      return { status: mapOrderStatus(String(order.status)), fills: [], raw: order };
    }
    return { status: "unknown", fills: [], raw: { order, trades: [] } };
  }

  async cancelByHash(signedOrderHash: Hex): Promise<CancelResult> {
    const raw = await this.#client.cancelOrder({ orderID: signedOrderHash });
    return { cancelled: !hasError(raw), raw };
  }
}

function toSdkSignatureType(signatureType: 0 | 1 | 3): SignatureTypeV2 {
  if (signatureType === 1) return SignatureTypeV2.POLY_PROXY;
  if (signatureType === 3) return SignatureTypeV2.POLY_1271;
  return SignatureTypeV2.EOA;
}

function hashSignedOrderV2(order: SignedOrder, negRisk: boolean): Hex {
  const payload = order as Record<string, unknown>;
  if (!("timestamp" in payload)) {
    throw new Error("live trading requires CLOB V2 signed orders");
  }
  return hashTypedData({
    domain: {
      name: "Polymarket CTF Exchange",
      version: "2",
      chainId: 137,
      verifyingContract: negRisk ? NEG_RISK_CTF_EXCHANGE_V2 : CTF_EXCHANGE_V2
    },
    types: orderTypesV2,
    primaryType: "Order",
    message: {
      salt: BigInt(readRequiredString(payload.salt, "salt")),
      maker: readRequiredString(payload.maker, "maker") as Hex,
      signer: readRequiredString(payload.signer, "signer") as Hex,
      tokenId: BigInt(readRequiredString(payload.tokenId, "tokenId")),
      makerAmount: BigInt(readRequiredString(payload.makerAmount, "makerAmount")),
      takerAmount: BigInt(readRequiredString(payload.takerAmount, "takerAmount")),
      side: payload.side === Side.BUY || payload.side === "BUY" ? 0 : 1,
      signatureType: Number(payload.signatureType),
      timestamp: BigInt(readRequiredString(payload.timestamp, "timestamp")),
      metadata: readRequiredString(payload.metadata, "metadata") as Hex,
      builder: readRequiredString(payload.builder, "builder") as Hex
    }
  }) as Hex;
}

function normalizeSubmitResult(raw: unknown): SubmitResult {
  const record = isRecord(raw) ? raw : {};
  const error = record.error;
  return {
    success: record.success === true && (error === undefined || error === null),
    errorMsg: readOptionalString(record.errorMsg) ?? readOptionalString(error) ?? "",
    errorCode: readOptionalString(record.errorCode) ?? readOptionalString(record.code) ?? readOptionalString(record.status),
    error,
    orderID: asHex(readOptionalString(record.orderID)),
    takingAmount: readOptionalString(record.takingAmount),
    makingAmount: readOptionalString(record.makingAmount),
    status: mapSubmitStatus(record.status),
    transactionsHashes: readHexArray(record.transactionsHashes),
    tradeIDs: readStringArray(record.tradeIDs),
    raw
  };
}

function mapSubmitStatus(value: unknown): SubmitResult["status"] {
  if (value === "live" || value === "matched" || value === "delayed" || value === "unmatched") return value;
  return undefined;
}

function mapOrderStatus(value: string): OrderStatusResult["status"] {
  const normalized = value.toLowerCase();
  if (normalized === "live" || normalized === "matched" || normalized === "delayed" || normalized === "unmatched") return normalized;
  if (normalized === "cancelled" || normalized === "filled" || normalized === "failed") return normalized;
  return "unknown";
}

function tradeToFill(
  signedOrderHash: Hex,
  trade: { id: string; side: "BUY" | "SELL"; size: string; price: string; match_time?: string; transaction_hash?: string }
): OrderStatusResult["fills"][number] {
  const pricePpm = decimalPriceToPpm(trade.price);
  const sizeRaw = BigInt(decimalSharesToRaw(trade.size));
  const notionalRaw = (sizeRaw * BigInt(pricePpm)) / 1_000_000n;
  return {
    tradeId: trade.id,
    fillHash: `${trade.transaction_hash ?? signedOrderHash}:${trade.id}`,
    pricePpm,
    sizeRaw: sizeRaw.toString(),
    pUsdDeltaRaw: trade.side === "BUY" ? `-${notionalRaw.toString()}` : notionalRaw.toString(),
    feeRaw: "0",
    occurredAt: parseClobMatchTime(trade.match_time)
  };
}

export function parseClobMatchTime(value: unknown, fallbackNowMs = Date.now()): string {
  const parsedMs = parseTimestampMs(value);
  const fallbackMs = Number.isFinite(fallbackNowMs) ? fallbackNowMs : Date.now();
  return new Date(parsedMs ?? fallbackMs).toISOString();
}

function parseTimestampMs(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") return timestampNumberToMs(value);
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return timestampNumberToMs(Number(trimmed));
  }

  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function timestampNumberToMs(value: number): number | null {
  if (!Number.isFinite(value) || value < 0) return null;
  return value < 1_000_000_000_000 ? Math.trunc(value * 1_000) : Math.trunc(value);
}

function rawAmountToDecimal(raw: bigint): number {
  return Number(raw) / 1_000_000;
}

function decimalPriceToPpm(price: string): number {
  return Number(decimalToRaw(price, 6));
}

export function decimalSharesToRaw(size: string): string {
  return decimalToRaw(size, 6).toString();
}

function decimalToRaw(value: string, decimals: number): bigint {
  const trimmed = value.trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) {
    throw new Error(`invalid decimal amount: ${value}`);
  }

  const integer = BigInt(match[1]);
  const fraction = match[2] ?? "";
  const padded = (fraction + "0".repeat(decimals)).slice(0, decimals);
  let raw = integer * 10n ** BigInt(decimals) + BigInt(padded);

  const nextDigit = fraction[decimals];
  if (nextDigit !== undefined && Number(nextDigit) >= 5) {
    raw += 1n;
  }
  return raw;
}

function readAllowance(allowances: Record<string, string>, spender: Hex): string {
  const exact = allowances[spender];
  if (exact !== undefined) return exact;
  const lower = spender.toLowerCase();
  for (const [key, value] of Object.entries(allowances)) {
    if (key.toLowerCase() === lower) return value;
  }
  return "0";
}

function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`signed order ${label} must be a string`);
  return value;
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

function readHexArray(value: unknown): Hex[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Hex => typeof entry === "string" && entry.startsWith("0x")) as Hex[];
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function asHex(value: string | undefined): Hex | undefined {
  return value?.startsWith("0x") ? (value as Hex) : undefined;
}

function hasError(value: unknown): boolean {
  return isRecord(value) && "error" in value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
