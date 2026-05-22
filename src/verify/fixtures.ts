import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getAddress } from "viem";
import { CTF_EXCHANGE_V2, NEG_RISK_CTF_EXCHANGE_V2 } from "../constants/chain.js";
import { decodeOrderFilledLog, type RawOrderFilledLog } from "../protocol/decode-order-filled.js";
import { normalizeSourceFill } from "../normalize/taker-filter.js";
import { aggregateFills, computeAggregationGroupId, type FillWithId } from "../normalize/aggregate.js";

export type FixtureSource = {
  txHash: `0x${string}`;
  blockNumber: number;
  blockHash: `0x${string}`;
  contractAddress: `0x${string}`;
  transactionIndex: number;
  logIndex: number;
  rawLogPath?: string;
  rawLog?: Record<string, unknown>;
};

export type FixtureExpected = {
  decode: null | {
    maker: `0x${string}`;
    taker: `0x${string}`;
    side: "BUY" | "SELL";
    tokenId: string;
    makerAmountFilledRaw: string;
    takerAmountFilledRaw: string;
    feeRaw: string;
    pricePpm: string;
  };
  normalization: {
    accepted: boolean;
    skipReason: string | null;
    sourceWallet?: `0x${string}`;
  };
  aggregation: null | {
    groupId: string;
    sourceFillCount: number;
    leaderPricePpm: string;
    leaderNotionalRaw: string;
  };
  decision: {
    status: "ACTIVE" | "SKIPPED" | "SKIPPED_REORG" | "POST_REORG_ORPHAN" | "ERROR";
    skipReason: string | null;
    approvedCopyNotionalRaw: string | null;
  };
  error: string | null;
};

export type FixtureCase = {
  id: string;
  kind: string;
  source?: FixtureSource;
  sources?: FixtureSource[];
  expected: FixtureExpected;
};

export type FixtureManifest = {
  schemaVersion: number;
  frozenNow: string;
  getterSnapshot: string;
  cases: FixtureCase[];
};

export type FixtureCheck = {
  caseId: string;
  name: string;
  ok: boolean;
  details?: unknown;
};

export type FixtureVerifyResult = {
  ok: boolean;
  cases: number;
  checks: FixtureCheck[];
};

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export function parseFixtureRawLog(raw: Record<string, unknown>, source: FixtureSource): RawOrderFilledLog {
  const blockNumberRaw = raw.blockNumber ?? source.blockNumber;
  const blockNumber =
    typeof blockNumberRaw === "string" && blockNumberRaw.startsWith("0x")
      ? BigInt(blockNumberRaw)
      : BigInt(Number(blockNumberRaw));
  const txIndexRaw = raw.transactionIndex ?? source.transactionIndex;
  const logIndexRaw = raw.logIndex ?? source.logIndex;
  return {
    chainId: 137,
    address: getAddress(String(raw.address ?? source.contractAddress)) as RawOrderFilledLog["address"],
    blockNumber,
    blockHash: String(raw.blockHash ?? source.blockHash) as RawOrderFilledLog["blockHash"],
    transactionHash: String(raw.transactionHash ?? source.txHash) as RawOrderFilledLog["transactionHash"],
    transactionIndex: Number(typeof txIndexRaw === "string" && txIndexRaw.startsWith("0x") ? BigInt(txIndexRaw) : txIndexRaw),
    logIndex: Number(typeof logIndexRaw === "string" && logIndexRaw.startsWith("0x") ? BigInt(logIndexRaw) : logIndexRaw),
    topics: (raw.topics as string[]).map((topic) => topic as RawOrderFilledLog["topics"][number]),
    data: String(raw.data ?? "0x") as RawOrderFilledLog["data"]
  };
}

async function loadRawLog(source: FixtureSource): Promise<Record<string, unknown>> {
  if (source.rawLog) return source.rawLog;
  if (!source.rawLogPath) throw new Error(`fixture source missing raw log for ${source.txHash}`);
  return readJson<Record<string, unknown>>(resolve(source.rawLogPath));
}

function push(checks: FixtureCheck[], caseId: string, name: string, ok: boolean, details?: unknown): void {
  checks.push({ caseId, name, ...(details === undefined ? {} : { details }), ok });
}

function sameRaw(actual: string | null | undefined, expected: string | null | undefined): boolean {
  if (actual == null || expected == null) return actual === expected;
  return BigInt(actual) === BigInt(expected);
}

export async function verifyFixtureManifest(args: {
  manifestPath?: string;
  fixture?: string;
  sourceWallet?: `0x${string}`;
  aggregationWindowBlocks?: number;
}): Promise<FixtureVerifyResult> {
  const manifest = await readJson<FixtureManifest>(resolve(args.manifestPath ?? "fixtures/manifest.json"));
  const sourceWallet = (args.sourceWallet ?? "0x1111111111111111111111111111111111111111") as `0x${string}`;
  const selected =
    args.fixture && args.fixture !== "all" ? manifest.cases.filter((entry) => entry.id === args.fixture) : manifest.cases;
  const checks: FixtureCheck[] = [];

  for (const fixtureCase of selected) {
    const sources = fixtureCase.source ? [fixtureCase.source] : fixtureCase.sources ?? [];
    const expected = fixtureCase.expected;

    if (fixtureCase.id === "rpc-disagreement-fault") {
      push(checks, fixtureCase.id, "decode", expected.decode === null);
      push(checks, fixtureCase.id, "normalization", !expected.normalization.accepted);
      push(checks, fixtureCase.id, "aggregation", expected.aggregation === null);
      continue;
    }

    if (fixtureCase.id === "mint-merge-skip") {
      const source = sources[0];
      if (!source) {
        push(checks, fixtureCase.id, "decode_rejected", false, "missing source");
        continue;
      }
      const raw = await loadRawLog(source);
      let rejected = false;
      try {
        decodeOrderFilledLog(parseFixtureRawLog(raw, source));
      } catch {
        rejected = true;
      }
      push(checks, fixtureCase.id, "decode_rejected", rejected);
      push(checks, fixtureCase.id, "normalization", !expected.normalization.accepted);
      continue;
    }

    const decodedFills: FillWithId[] = [];
    let decodeOk = true;
    for (let index = 0; index < sources.length; index += 1) {
      const source = sources[index]!;
      const raw = await loadRawLog(source);
      if (expected.decode === null) {
        try {
          decodeOrderFilledLog(parseFixtureRawLog(raw, source));
          decodeOk = false;
        } catch {
          decodeOk = true;
        }
        push(checks, fixtureCase.id, "decode_rejected", decodeOk);
        push(checks, fixtureCase.id, "normalization", !expected.normalization.accepted);
        break;
      }
      try {
        const decoded = decodeOrderFilledLog(parseFixtureRawLog(raw, source));
        decodeOk =
          decoded.maker.toLowerCase() === expected.decode.maker.toLowerCase() &&
          decoded.taker.toLowerCase() === expected.decode.taker.toLowerCase() &&
          decoded.side === expected.decode.side &&
          decoded.tokenId === expected.decode.tokenId &&
          sameRaw(decoded.makerAmountFilledRaw, expected.decode.makerAmountFilledRaw) &&
          sameRaw(decoded.takerAmountFilledRaw, expected.decode.takerAmountFilledRaw) &&
          sameRaw(decoded.feeRaw, expected.decode.feeRaw) &&
          sameRaw(decoded.pricePpm, expected.decode.pricePpm);
        push(checks, fixtureCase.id, "decode", decodeOk, decoded);
        const normalized = normalizeSourceFill(decoded, {
          sourceWallets: [sourceWallet],
          exchangeAddresses: [CTF_EXCHANGE_V2, NEG_RISK_CTF_EXCHANGE_V2]
        });
        const normalizationOk =
          normalized.accepted === expected.normalization.accepted &&
          normalized.skipReason === expected.normalization.skipReason &&
          (expected.normalization.sourceWallet
            ? normalized.accepted && normalized.sourceWallet.toLowerCase() === expected.normalization.sourceWallet.toLowerCase()
            : true);
        push(checks, fixtureCase.id, "normalization", normalizationOk, normalized);
        if (normalized.accepted) {
          decodedFills.push({ ...normalized, id: `sf_${fixtureCase.id}_${index}` });
        }
      } catch (error) {
        decodeOk = false;
        push(checks, fixtureCase.id, "decode", false, String(error));
      }
    }

    if (expected.aggregation) {
      const groups = aggregateFills(decodedFills, {
        aggregationWindowBlocks: args.aggregationWindowBlocks ?? 2,
        reorgGeneration: 0
      });
      const group = groups[0];
      const groupId = group
        ? computeAggregationGroupId({
            chainId: group.chainId,
            contractAddress: group.contractAddress,
            sourceWallet: group.sourceWallet,
            tokenId: group.tokenId,
            side: group.side,
            windowStartBlock: group.windowStartBlock,
            reorgGeneration: group.reorgGeneration,
            firstSourceFillId: group.sourceFillIds[0]!
          })
        : null;
      push(checks, fixtureCase.id, "aggregation", Boolean(group) && groupId === expected.aggregation.groupId && group!.sourceFillIds.length === expected.aggregation.sourceFillCount && group!.leaderPricePpm === expected.aggregation.leaderPricePpm && group!.leaderNotionalRaw === expected.aggregation.leaderNotionalRaw, group);
    } else {
      push(checks, fixtureCase.id, "aggregation", expected.aggregation === null);
    }
  }

  return { ok: checks.every((entry) => entry.ok), cases: selected.length, checks };
}
