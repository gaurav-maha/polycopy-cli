import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getAddress } from "viem";
import { CTF_EXCHANGE_V2, NEG_RISK_CTF_EXCHANGE_V2 } from "../src/constants/chain.js";
import { decodeOrderFilledLog, type RawOrderFilledLog } from "../src/protocol/decode-order-filled.js";
import { normalizeSourceFill } from "../src/normalize/taker-filter.js";
import { aggregateFills, computeAggregationGroupId, type FillWithId } from "../src/normalize/aggregate.js";
import { applyDecimalPct } from "../src/risk/size-notional.js";

const LEADER = "0x1111111111111111111111111111111111111111";
const COPY_PCT = "0.20";

type Manifest = {
  schemaVersion: number;
  frozenNow: string;
  getterSnapshot: string;
  cases: Array<Record<string, unknown>>;
};

function parseRawLog(raw: Record<string, unknown>, source: Record<string, unknown>): RawOrderFilledLog {
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
    data: String(raw.data) as RawOrderFilledLog["data"]
  };
}

async function main(): Promise<void> {
  const manifestPath = resolve("fixtures/manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;

  for (const fixtureCase of manifest.cases) {
    const id = String(fixtureCase.id);
    const sources = fixtureCase.source ? [fixtureCase.source] : (fixtureCase.sources as Array<Record<string, unknown>>);
    const expected = fixtureCase.expected as Record<string, unknown>;

    if (id === "rpc-disagreement-fault") {
      expected.decode = null;
      expected.normalization = { accepted: false, skipReason: "RPC_DISAGREEMENT" };
      expected.aggregation = null;
      expected.decision = { status: "ERROR", skipReason: "RPC_DISAGREEMENT", approvedCopyNotionalRaw: null };
      continue;
    }

    if (id === "mint-merge-skip") {
      expected.decode = null;
      expected.normalization = { accepted: false, skipReason: "ROLE_AMBIGUOUS" };
      expected.aggregation = null;
      expected.decision = { status: "SKIPPED", skipReason: "ROLE_AMBIGUOUS", approvedCopyNotionalRaw: null };
      continue;
    }

    const decodedFills: FillWithId[] = [];
    for (let index = 0; index < sources.length; index += 1) {
      const source = sources[index]!;
      const rawPath = String(source.rawLogPath);
      const raw = JSON.parse(await readFile(resolve(rawPath), "utf8")) as Record<string, unknown>;
      if (id === "stale-v1-rejection") {
        expected.decode = null;
        expected.normalization = { accepted: false, skipReason: "ROLE_AMBIGUOUS" };
        expected.aggregation = null;
        expected.decision = { status: "SKIPPED", skipReason: "ERROR", approvedCopyNotionalRaw: null };
        expected.error = "stale V1-shaped OrderFilled data rejected";
        break;
      }
      const rawLog = parseRawLog(raw, source);
      const decoded = decodeOrderFilledLog(rawLog);
      const normalized = normalizeSourceFill(decoded, {
        sourceWallet: LEADER,
        exchangeAddresses: [CTF_EXCHANGE_V2, NEG_RISK_CTF_EXCHANGE_V2]
      });
      expected.decode = {
        maker: decoded.maker,
        taker: decoded.taker,
        side: decoded.side,
        tokenId: decoded.tokenId,
        makerAmountFilledRaw: decoded.makerAmountFilledRaw,
        takerAmountFilledRaw: decoded.takerAmountFilledRaw,
        feeRaw: decoded.feeRaw,
        pricePpm: decoded.pricePpm
      };
      if (!normalized.accepted) {
        expected.normalization = { accepted: false, skipReason: normalized.skipReason };
        expected.aggregation = null;
        expected.decision = {
          status: "SKIPPED",
          skipReason: normalized.skipReason,
          approvedCopyNotionalRaw: null
        };
        decodedFills.length = 0;
        break;
      }
      expected.normalization = {
        accepted: true,
        skipReason: null,
        sourceWallet: normalized.sourceWallet
      };
      decodedFills.push({ ...decoded, id: `sf_${fixtureCase.id}_${index}` });
    }

    if (decodedFills.length === 0) continue;

    const groups = aggregateFills(decodedFills, { aggregationWindowBlocks: 2, reorgGeneration: 0 });
    const group = groups[0]!;
    expected.aggregation = {
      groupId: computeAggregationGroupId({
        chainId: group.chainId,
        contractAddress: group.contractAddress,
        sourceWallet: group.sourceWallet,
        tokenId: group.tokenId,
        side: group.side,
        windowStartBlock: group.windowStartBlock,
        reorgGeneration: group.reorgGeneration,
        firstSourceFillId: group.sourceFillIds[0]!
      }),
      sourceFillCount: group.sourceFillIds.length,
      leaderPricePpm: group.leaderPricePpm,
      leaderNotionalRaw: group.leaderNotionalRaw
    };

    if (group.side === "SELL") {
      expected.decision = { status: "SKIPPED", skipReason: "SIDE_DISABLED", approvedCopyNotionalRaw: null };
      continue;
    }

    if (id === "ws-book-gap-fault") {
      expected.decision = { status: "SKIPPED", skipReason: "BOOK_GAP", approvedCopyNotionalRaw: null };
      continue;
    }

    if (id === "stale-v1-rejection") continue;

    const approved = applyDecimalPct(group.leaderNotionalRaw, COPY_PCT);
    expected.decision = {
      status: "ACTIVE",
      skipReason: null,
      approvedCopyNotionalRaw: approved.toString()
    };
  }

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

await main();
