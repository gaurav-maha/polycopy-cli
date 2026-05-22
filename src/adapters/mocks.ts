import {
  BlockRef,
  CancelResult,
  ChainLog,
  Clock,
  ClobBalanceAllowanceSnapshot,
  ClobRestAdapter,
  Hex,
  MarketMetadata,
  MarketWsAdapter,
  MockFault,
  MockFaultKnob,
  OrderBookSnapshot,
  OrderStatusResult,
  RpcAdapter,
  RpcLogTopic,
  SubmitResult
} from "./types.js";

type RpcReadKey = string;

type MockRpcAdapterArgs = {
  clock: Clock;
  blocks?: BlockRef[];
  logs?: ChainLog[];
  codes?: Record<string, Hex>;
  receipts?: Record<string, { blockHash: Hex; logs: ChainLog[] }>;
  contractReads?: Record<RpcReadKey, unknown>;
  faults?: MockFaultKnob[];
};

type MockClobRestAdapterArgs = {
  clock: Clock;
  markets?: MarketMetadata[];
  books?: OrderBookSnapshot[];
  balances?: ClobBalanceAllowanceSnapshot[];
  submitResults?: Record<string, SubmitResult>;
  orderStatuses?: Record<string, OrderStatusResult>;
  cancelResults?: Record<string, CancelResult>;
  faults?: MockFaultKnob[];
};

type MockMarketWsAdapterArgs = {
  clock: Clock;
  snapshots?: OrderBookSnapshot[];
  faults?: MockFaultKnob[];
};

type Invalidation = { tokenId: string; reason: string; atMs: number };

export class MockClock implements Clock {
  #nowMs: number;

  constructor(nowMs: number) {
    this.#nowMs = nowMs;
  }

  nowMs(): number {
    return this.#nowMs;
  }

  setNowMs(nowMs: number): void {
    this.#nowMs = nowMs;
  }

  advanceMs(deltaMs: number): void {
    this.#nowMs += deltaMs;
  }
}

export class MockRpcAdapter implements RpcAdapter {
  readonly #clock: Clock;
  readonly #blocks: BlockRef[];
  readonly #logs: ChainLog[];
  readonly #codes: Map<string, Hex>;
  readonly #receipts: Map<string, { blockHash: Hex; logs: ChainLog[] }>;
  readonly #contractReads: Map<RpcReadKey, unknown>;
  #faults: MockFaultKnob[];

  constructor(args: MockRpcAdapterArgs) {
    this.#clock = args.clock;
    this.#blocks = [...(args.blocks ?? [])].sort((a, b) => Number(a.number - b.number));
    this.#logs = [...(args.logs ?? [])].sort((a, b) =>
      a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : Number(a.blockNumber - b.blockNumber)
    );
    this.#codes = new Map(Object.entries(args.codes ?? {}).map(([address, code]) => [address.toLowerCase(), code]));
    this.#receipts = new Map(
      Object.entries(args.receipts ?? {}).map(([txHash, receipt]) => [txHash.toLowerCase(), receipt])
    );
    this.#contractReads = new Map(Object.entries(args.contractReads ?? {}));
    this.#faults = [...(args.faults ?? [])];
  }

  setFault(fault: MockFaultKnob): void {
    this.#faults = [fault];
  }

  clearFaults(): void {
    this.#faults = [];
  }

  async getChainId(): Promise<137> {
    return 137;
  }

  async getLatestBlock(): Promise<BlockRef> {
    if (this.#blocks.length === 0) {
      throw new Error("MockRpcAdapter has no fixture blocks");
    }
    if (this.#hasFault("RPC_STALE_HEAD") && this.#blocks.length > 1) {
      return this.#blocks[this.#blocks.length - 2]!;
    }
    return this.#blocks[this.#blocks.length - 1]!;
  }

  async getBlock(number: bigint): Promise<BlockRef> {
    const block = this.#blocks.find((candidate) => candidate.number === number);
    if (!block) {
      throw new Error(`MockRpcAdapter missing block ${number.toString()}`);
    }
    return block;
  }

  async getCode(args: { address: Hex; blockTag?: bigint | "latest" }): Promise<Hex> {
    void args.blockTag;
    return this.#codes.get(args.address.toLowerCase()) ?? "0x";
  }

  async getLogs(args: { fromBlock: bigint; toBlock: bigint; addresses: Hex[]; topics: RpcLogTopic[] }): Promise<ChainLog[]> {
    const addresses = new Set(args.addresses.map((address) => address.toLowerCase()));
    const matchingLogs = this.#logs.filter((log) => {
      const inRange = log.blockNumber >= args.fromBlock && log.blockNumber <= args.toBlock;
      const addressMatches = addresses.size === 0 || addresses.has(log.address.toLowerCase());
      const topicMatches = args.topics.length === 0 || args.topics.every((topic, index) => topicMatchesLog(topic, log.topics[index]));
      return inRange && addressMatches && topicMatches;
    });

    if (this.#hasFault("RPC_SPOOFED_LOG") && matchingLogs[0]) {
      return [
        {
          ...matchingLogs[0],
          transactionHash: `0x${"f".repeat(64)}`
        },
        ...matchingLogs.slice(1)
      ];
    }
    return matchingLogs;
  }

  async getTransactionReceipt(txHash: Hex): Promise<{ blockHash: Hex; logs: ChainLog[] }> {
    if (this.#hasFault("RPC_LOG_DISAGREEMENT")) {
      throw new Error("fixture RPC_LOG_DISAGREEMENT");
    }
    const keyedReceipt = this.#receipts.get(txHash.toLowerCase());
    if (keyedReceipt) {
      return keyedReceipt;
    }
    const logs = this.#logs.filter((log) => log.transactionHash.toLowerCase() === txHash.toLowerCase());
    if (logs.length === 0) {
      throw new Error(`MockRpcAdapter missing receipt ${txHash}`);
    }
    return { blockHash: logs[0]!.blockHash, logs };
  }

  async readContract<T>(args: {
    address: Hex;
    abi: unknown;
    functionName: string;
    args?: unknown[];
    blockTag?: bigint | "latest";
  }): Promise<T> {
    void args.abi;
    void args.blockTag;
    const key = contractReadKey(args.address, args.functionName, args.args ?? []);
    if (!this.#contractReads.has(key)) {
      throw new Error(`MockRpcAdapter missing contract read ${key}`);
    }
    const value = this.#contractReads.get(key);
    if (Array.isArray(value)) {
      const [current, ...remaining] = value;
      this.#contractReads.set(key, remaining.length > 0 ? remaining : [current]);
      return current as T;
    }
    return value as T;
  }

  #hasFault(kind: MockFault): boolean {
    return hasFault(this.#faults, kind);
  }
}

function topicMatchesLog(topic: RpcLogTopic, actual: Hex | undefined): boolean {
  if (topic === null) return true;
  if (!actual) return false;
  if (Array.isArray(topic)) return topic.some((entry) => entry.toLowerCase() === actual.toLowerCase());
  return topic.toLowerCase() === actual.toLowerCase();
}

export class MockClobRestAdapter implements ClobRestAdapter {
  readonly #clock: Clock;
  readonly #markets: Map<string, MarketMetadata>;
  readonly #books: Map<string, OrderBookSnapshot>;
  readonly #balances: Map<string, ClobBalanceAllowanceSnapshot>;
  readonly #submitResults: Map<string, SubmitResult>;
  readonly #orderStatuses: Map<string, OrderStatusResult>;
  readonly #cancelResults: Map<string, CancelResult>;
  #faults: MockFaultKnob[];

  constructor(args: MockClobRestAdapterArgs) {
    this.#clock = args.clock;
    this.#markets = new Map((args.markets ?? []).map((market) => [market.tokenId, market]));
    this.#books = new Map((args.books ?? []).map((book) => [book.tokenId, book]));
    this.#balances = new Map((args.balances ?? []).map((balance) => [balanceKey(balance), balance]));
    this.#submitResults = new Map(Object.entries(args.submitResults ?? {}).map(([hash, result]) => [hash.toLowerCase(), result]));
    this.#orderStatuses = new Map(
      Object.entries(args.orderStatuses ?? {}).map(([hash, result]) => [hash.toLowerCase(), result])
    );
    this.#cancelResults = new Map(Object.entries(args.cancelResults ?? {}).map(([hash, result]) => [hash.toLowerCase(), result]));
    this.#faults = [...(args.faults ?? [])];
  }

  setFault(fault: MockFaultKnob): void {
    this.#faults = [fault];
  }

  clearFaults(): void {
    this.#faults = [];
  }

  async getMarket(tokenId: string): Promise<MarketMetadata> {
    const market = this.#markets.get(tokenId);
    if (!market) {
      throw new Error(`MockClobRestAdapter missing market ${tokenId}`);
    }
    return market;
  }

  async getOrderBook(tokenId: string): Promise<OrderBookSnapshot> {
    const book = this.#books.get(tokenId);
    if (!book) {
      throw new Error(`MockClobRestAdapter missing order book ${tokenId}`);
    }
    return { ...book, source: "REST", receivedAtMs: book.receivedAtMs ?? this.#clock.nowMs() };
  }

  async getBalanceAllowance(args: {
    assetType: "COLLATERAL" | "CONDITIONAL";
    tokenId?: string;
    expectedFunder: Hex;
    expectedSpender: Hex;
    expectedSignatureType: 0 | 1 | 3;
  }): Promise<ClobBalanceAllowanceSnapshot> {
    const key = balanceKey(args);
    const balance = this.#balances.get(key);
    if (balance) {
      return this.#hasFault("BALANCE_CACHE_MISMATCH")
        ? { ...balance, balanceRaw: (BigInt(balance.balanceRaw) + 1n).toString(), receivedAtMs: this.#clock.nowMs() }
        : balance;
    }
    return {
      ...args,
      balanceRaw: "0",
      allowanceRaw: "0",
      receivedAtMs: this.#clock.nowMs(),
      raw: { fixture: "default-empty-balance" }
    };
  }

  async submitOrder(args: {
    signedOrder: { orderHash: Hex; payload: unknown };
    orderType: "FAK" | "FOK";
    postOnly?: false;
  }): Promise<SubmitResult> {
    void args.orderType;
    void args.postOnly;
    if (this.#hasFault("CLOB_TIMEOUT_UNKNOWN")) {
      return failedSubmitResult("CLOB_TIMEOUT_UNKNOWN", "fixture timeout after submit");
    }
    if (this.#hasFault("CLOB_REJECT_SEMANTIC")) {
      return failedSubmitResult("CLOB_REJECT_SEMANTIC", "fixture semantic rejection");
    }
    if (this.#hasFault("CLOB_LIVE_STATUS_UNEXPECTED")) {
      return {
        success: true,
        errorMsg: "",
        orderID: args.signedOrder.orderHash,
        status: "live",
        transactionsHashes: [],
        tradeIDs: [],
        raw: { fixture: "unexpected-live-status" }
      };
    }
    return (
      this.#submitResults.get(args.signedOrder.orderHash.toLowerCase()) ?? {
        success: true,
        errorMsg: "",
        orderID: args.signedOrder.orderHash,
        status: "matched",
        transactionsHashes: [],
        tradeIDs: [],
        raw: { fixture: "default-submit" }
      }
    );
  }

  async getOrderByHash(signedOrderHash: Hex): Promise<OrderStatusResult> {
    return (
      this.#orderStatuses.get(signedOrderHash.toLowerCase()) ?? {
        status: "unknown",
        fills: [],
        raw: { fixture: "default-order-status" }
      }
    );
  }

  async cancelByHash(signedOrderHash: Hex): Promise<CancelResult> {
    return (
      this.#cancelResults.get(signedOrderHash.toLowerCase()) ?? {
        cancelled: true,
        raw: { fixture: "default-cancel", signedOrderHash }
      }
    );
  }

  #hasFault(kind: MockFault): boolean {
    return hasFault(this.#faults, kind);
  }
}

export class MockMarketWsAdapter implements MarketWsAdapter {
  readonly #clock: Clock;
  readonly #snapshots: Map<string, OrderBookSnapshot>;
  readonly #invalidations: Invalidation[];
  #faults: MockFaultKnob[];
  #connected: boolean;

  constructor(args: MockMarketWsAdapterArgs) {
    this.#clock = args.clock;
    this.#snapshots = new Map((args.snapshots ?? []).map((snapshot) => [snapshot.tokenId, snapshot]));
    this.#invalidations = [];
    this.#faults = [...(args.faults ?? [])];
    this.#connected = false;
  }

  setFault(fault: MockFaultKnob): void {
    this.#faults = [fault];
  }

  clearFaults(): void {
    this.#faults = [];
  }

  getInvalidations(): Invalidation[] {
    return [...this.#invalidations];
  }

  async connect(): Promise<void> {
    if (this.#hasFault("WS_PARSE_ERROR")) {
      throw new Error("fixture WS_PARSE_ERROR");
    }
    this.#connected = true;
  }

  async getSnapshot(tokenId: string): Promise<OrderBookSnapshot | null> {
    if (!this.#connected || this.#hasFault("WS_GAP")) {
      return null;
    }
    if (this.#hasFault("WS_PARSE_ERROR")) {
      throw new Error("fixture WS_PARSE_ERROR");
    }
    const snapshot = this.#snapshots.get(tokenId);
    if (!snapshot) {
      return null;
    }
    if (this.#hasFault("WS_CROSSED_BOOK")) {
      return {
        ...snapshot,
        bids: snapshot.bids.length > 0 ? [{ ...snapshot.bids[0]!, pricePpm: 700_000 }, ...snapshot.bids.slice(1)] : [],
        asks: snapshot.asks.length > 0 ? [{ ...snapshot.asks[0]!, pricePpm: 300_000 }, ...snapshot.asks.slice(1)] : []
      };
    }
    if (this.#hasFault("WS_RECONNECT")) {
      this.#connected = false;
      return null;
    }
    return snapshot;
  }

  invalidate(tokenId: string, reason: string): void {
    this.#snapshots.delete(tokenId);
    this.#invalidations.push({ tokenId, reason, atMs: this.#clock.nowMs() });
  }

  #hasFault(kind: MockFault): boolean {
    return hasFault(this.#faults, kind);
  }
}

function contractReadKey(address: Hex, functionName: string, args: unknown[]): string {
  return `${address.toLowerCase()}:${functionName}:${JSON.stringify(args, (_, value) =>
    typeof value === "bigint" ? value.toString() : value
  )}`;
}

function balanceKey(args: {
  assetType: "COLLATERAL" | "CONDITIONAL";
  tokenId?: string;
  expectedFunder: Hex;
  expectedSpender: Hex;
  expectedSignatureType: 0 | 1 | 3;
}): string {
  return [
    args.assetType,
    args.tokenId ?? "",
    args.expectedFunder.toLowerCase(),
    args.expectedSpender.toLowerCase(),
    String(args.expectedSignatureType)
  ].join(":");
}

function failedSubmitResult(errorCode: string, errorMsg: string): SubmitResult {
  return {
    success: false,
    errorMsg,
    errorCode,
    transactionsHashes: [],
    tradeIDs: [],
    raw: { fixture: errorCode }
  };
}

function hasFault(faults: MockFaultKnob[], kind: MockFault): boolean {
  return faults.some((fault) => (typeof fault === "string" ? fault === kind : fault.kind === kind));
}

export { contractReadKey };
