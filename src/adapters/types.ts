export type Hex = `0x${string}`;
export type RpcLogTopic = Hex | Hex[] | null;

export type ChainLog = {
  chainId: 137;
  address: Hex;
  blockNumber: bigint;
  blockHash: Hex;
  transactionHash: Hex;
  transactionIndex: number;
  logIndex: number;
  topics: Hex[];
  data: Hex;
};

export type BlockRef = { number: bigint; hash: Hex; timestampMs: number };

export type MarketMetadata = {
  tokenId: string;
  source: "REST" | "FIXTURE";
  receivedAtMs: number;
  conditionId: Hex;
  outcome: string;
  negRisk: boolean;
  active: boolean;
  resolved: boolean;
  paused: boolean;
  tickSize: string;
  tickSizePpm: number;
  minOrderSizeSharesDecimal: string;
  feeConfig: { r: string; e: string; to: string; raw: unknown };
};

export type OrderBookLevel = { pricePpm: number; sizeRaw: string };
export type OrderBookSnapshot = {
  tokenId: string;
  source: "WS" | "REST";
  snapshotId?: string;
  sequence?: number;
  receivedAtMs: number;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
};

export type SignedClobOrder = {
  orderHash: Hex;
  payload: unknown;
};

export type SubmitResult = {
  success: boolean;
  errorMsg: string;
  errorCode?: string;
  error?: unknown;
  orderID?: Hex;
  takingAmount?: string;
  makingAmount?: string;
  status?: "live" | "matched" | "delayed" | "unmatched";
  transactionsHashes: Hex[];
  tradeIDs: string[];
  raw: unknown;
};

export type OrderStatusResult = {
  status: "live" | "matched" | "delayed" | "unmatched" | "cancelled" | "filled" | "failed" | "unknown";
  fills: Array<{
    tradeId?: string;
    fillHash: string;
    pricePpm: number;
    sizeRaw: string;
    pUsdDeltaRaw: string;
    feeRaw: string;
    occurredAt: string;
  }>;
  raw: unknown;
};
export type CancelResult = { cancelled: boolean; raw: unknown };

export type ClobBalanceAllowanceSnapshot = {
  assetType: "COLLATERAL" | "CONDITIONAL";
  tokenId?: string;
  expectedFunder: Hex;
  expectedSpender: Hex;
  expectedSignatureType: 0 | 1 | 3;
  balanceRaw: string;
  allowanceRaw: string;
  receivedAtMs: number;
  raw: unknown;
};

export interface RpcAdapter {
  getChainId(): Promise<137>;
  getLatestBlock(): Promise<BlockRef>;
  getBlock(number: bigint): Promise<BlockRef>;
  getCode(args: { address: Hex; blockTag?: bigint | "latest" }): Promise<Hex>;
  getLogs(args: { fromBlock: bigint; toBlock: bigint; addresses: Hex[]; topics: RpcLogTopic[] }): Promise<ChainLog[]>;
  getTransactionReceipt(txHash: Hex): Promise<{ blockHash: Hex; logs: ChainLog[] }>;
  readContract<T>(args: {
    address: Hex;
    abi: unknown;
    functionName: string;
    args?: unknown[];
    blockTag?: bigint | "latest";
  }): Promise<T>;
}

export interface LogSubscriptionAdapter {
  subscribeOrderFilled(args: {
    leaders: Hex[];
    exchangeAddresses: Hex[];
    onLog: (log: ChainLog) => void | Promise<void>;
  }): Promise<() => void>;
}

export interface BlockHeadAdapter {
  watchBlockHead(onHead: (head: BlockRef) => void | Promise<void>): Promise<() => void>;
}

export interface ClobRestAdapter {
  getMarket(tokenId: string): Promise<MarketMetadata>;
  getOrderBook(tokenId: string): Promise<OrderBookSnapshot>;
  getBalanceAllowance(args: {
    assetType: "COLLATERAL" | "CONDITIONAL";
    tokenId?: string;
    expectedFunder: Hex;
    expectedSpender: Hex;
    expectedSignatureType: 0 | 1 | 3;
  }): Promise<ClobBalanceAllowanceSnapshot>;
  submitOrder(args: { signedOrder: SignedClobOrder; orderType: "FAK" | "FOK"; postOnly?: false }): Promise<SubmitResult>;
  getOrderByHash(signedOrderHash: Hex): Promise<OrderStatusResult>;
  cancelByHash(signedOrderHash: Hex): Promise<CancelResult>;
}

export interface MarketWsAdapter {
  connect(): Promise<void>;
  getSnapshot(tokenId: string): Promise<OrderBookSnapshot | null>;
  invalidate(tokenId: string, reason: string): void;
}

export type MockFault =
  | "RPC_STALE_HEAD"
  | "RPC_SPOOFED_LOG"
  | "RPC_LOG_DISAGREEMENT"
  | "WS_GAP"
  | "WS_CROSSED_BOOK"
  | "WS_RECONNECT"
  | "WS_PARSE_ERROR"
  | "CLOB_TIMEOUT_UNKNOWN"
  | "CLOB_REJECT_SEMANTIC"
  | "CLOB_LIVE_STATUS_UNEXPECTED"
  | "BALANCE_CACHE_MISMATCH";

export type MockFaultKnob = MockFault | { kind: string; fixtureId?: string; details?: unknown };

export interface Clock {
  nowMs(): number;
}
