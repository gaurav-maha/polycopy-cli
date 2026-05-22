import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";

type FixtureManifest = {
  getterSnapshot: string;
  cases: Array<{
    source?: { rawLogPath?: string };
    sources?: Array<{ rawLogPath?: string }>;
  }>;
};

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function ajv() {
  const validator = new Ajv2020({ allErrors: true, strict: false });
  validator.addFormat("date-time", (value: string) => !Number.isNaN(Date.parse(value)));
  return validator;
}

describe("fixture schemas", () => {
  it("validates manifest and getter snapshot fixture files with AJV Draft 2020-12", async () => {
    const root = process.cwd();
    const manifestSchema = await readJson<Record<string, unknown>>(resolve(root, "fixtures/manifest.schema.json"));
    const getterSchema = await readJson<Record<string, unknown>>(resolve(root, "fixtures/getter_snapshot.schema.json"));
    const manifest = await readJson<FixtureManifest>(resolve(root, "fixtures/manifest.json"));
    const getterSnapshot = await readJson<Record<string, unknown>>(resolve(root, manifest.getterSnapshot));

    expect(manifestSchema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(getterSchema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");

    const validator = ajv();
    const validateManifestSchema = validator.compile(manifestSchema);
    const validateGetterSchema = validator.compile(getterSchema);

    expect(validateManifestSchema(manifest), JSON.stringify(validateManifestSchema.errors, null, 2)).toBe(true);
    expect(validateGetterSchema(getterSnapshot), JSON.stringify(validateGetterSchema.errors, null, 2)).toBe(true);

    const rawLogPaths = manifest.cases.flatMap((fixtureCase) => {
      if (fixtureCase.source?.rawLogPath) return [fixtureCase.source.rawLogPath];
      return fixtureCase.sources?.flatMap((source) => (source.rawLogPath ? [source.rawLogPath] : [])) ?? [];
    });
    expect(rawLogPaths.length).toBeGreaterThanOrEqual(8);

    for (const rawLogPath of rawLogPaths) {
      await access(resolve(root, rawLogPath));
    }
  });

  it("exposes deterministic mock adapters through the contract ports", async () => {
    const { MockClock, MockClobRestAdapter, MockMarketWsAdapter, MockRpcAdapter } = await import(
      "../../src/adapters/mocks.js"
    );

    const clock = new MockClock(1_779_408_000_000);
    const block = { number: 900n, hash: `0x${"1".repeat(64)}` as const, timestampMs: clock.nowMs() };
    const log = {
      chainId: 137 as const,
      address: `0x${"2".repeat(40)}` as const,
      blockNumber: block.number,
      blockHash: block.hash,
      transactionHash: `0x${"3".repeat(64)}` as const,
      transactionIndex: 0,
      logIndex: 0,
      topics: [`0x${"4".repeat(64)}` as const],
      data: "0x" as const
    };
    const market = {
      tokenId: "123",
      source: "FIXTURE" as const,
      receivedAtMs: clock.nowMs(),
      conditionId: `0x${"5".repeat(64)}` as const,
      outcome: "YES",
      negRisk: false,
      active: true,
      resolved: false,
      paused: false,
      tickSize: "0.01",
      tickSizePpm: 10_000,
      minOrderSizeSharesDecimal: "5",
      feeConfig: { r: "0", e: "0", to: `0x${"6".repeat(40)}`, raw: { fixture: true } }
    };
    const book = {
      tokenId: market.tokenId,
      source: "WS" as const,
      snapshotId: "fixture-book-1",
      sequence: 1,
      receivedAtMs: clock.nowMs(),
      bids: [{ pricePpm: 490_000, sizeRaw: "1000000" }],
      asks: [{ pricePpm: 510_000, sizeRaw: "1000000" }]
    };

    const rpc = new MockRpcAdapter({ clock, blocks: [block], logs: [log] });
    const rest = new MockClobRestAdapter({ clock, markets: [market], books: [book] });
    const ws = new MockMarketWsAdapter({ clock, snapshots: [book] });

    await expect(rpc.getChainId()).resolves.toBe(137);
    await expect(rpc.getLatestBlock()).resolves.toEqual(block);
    await expect(rpc.getLogs({ fromBlock: 900n, toBlock: 900n, addresses: [log.address], topics: [] })).resolves.toEqual([
      log
    ]);
    await expect(rest.getMarket("123")).resolves.toEqual(market);
    await expect(rest.getOrderBook("123")).resolves.toEqual({ ...book, source: "REST", receivedAtMs: clock.nowMs() });
    await ws.connect();
    await expect(ws.getSnapshot("123")).resolves.toEqual(book);

    rest.setFault("CLOB_REJECT_SEMANTIC");
    await expect(
      rest.submitOrder({
        signedOrder: { orderHash: `0x${"7".repeat(64)}`, payload: { fixture: true } },
        orderType: "FAK"
      })
    ).resolves.toMatchObject({ success: false, errorCode: "CLOB_REJECT_SEMANTIC" });
  });
});
