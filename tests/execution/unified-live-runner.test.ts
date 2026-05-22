import { afterEach, describe, expect, it } from "vitest";
import { dirname } from "node:path";
import type { Hex } from "../../src/adapters/types.js";
import { MockClobRestAdapter, MockClock, MockRpcAdapter } from "../../src/adapters/mocks.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import type { Config } from "../../src/config/schema.js";
import { runUnifiedLiveLoop } from "../../src/execution/unified-live-runner.js";
import type { LiveOrderSigner } from "../../src/execution/live-runner.js";
import type { TempDb } from "../helpers/temp-db.js";
import { createMigratedTempDb } from "../helpers/temp-db.js";

const owner = "0x1111111111111111111111111111111111111111" as Hex;
const leader = "0x9d84ce0306f8551e02efef1680475fc0f1dc1344" as Hex;

describe("unified live runner", () => {
  let tempDb: TempDb | undefined;
  let lockPath: string;

  afterEach(async () => {
    await tempDb?.cleanup();
    tempDb = undefined;
  });

  it("runs submit-only cycles without ingestion", async () => {
    tempDb = await createMigratedTempDb();
    const tempDir = dirname(tempDb.path);
    lockPath = `${tempDir}/live.lock`;
    const config = testConfig(tempDb.path, lockPath);
    const clock = new MockClock(Date.UTC(2026, 4, 22, 12));
    const clob = new MockClobRestAdapter({ clock, balances: [] });
    const rpc = new MockRpcAdapter({ clock, contractReads: {} });

    const summary = await runUnifiedLiveLoop({
      config,
      db: tempDb.db,
      leaders: [leader],
      rpcUrl: "https://polygon.example/primary",
      logPath: `${tempDir}/live.jsonl`,
      durationMs: 0,
      pollMs: 0,
      lookbackBlocks: 10n,
      risk: {
        copyPct: "0.10",
        maxTradePusdRaw: "1000000",
        maxDailySpendPusdRaw: "5000000",
        maxMarketPositionPusdRaw: "5000000",
        freeBudgetPusdRaw: "5000000",
        maxTradesPerDay: 5,
        maxTradeFractionOfBudgetBps: 5000,
        maxBuyPpm: 980_000,
        minSellPpm: 20_000,
        maxSpreadPpm: 80_000,
        maxDriftPpm: 30_000,
        maxBookParticipationBps: 1500,
        slippageCapPpm: 50_000
      },
      enableSell: false,
      clob,
      signer: fixedSigner(),
      rpc,
      owner,
      funder: owner,
      signatureType: 0,
      encryptionKey: new Uint8Array(32).fill(7),
      lockPath,
      killSwitchActive: () => false,
      skipIngestion: true,
      maxLiveCycles: 1
    });

    expect(summary.mode).toBe("submit-only");
    expect(summary.ingestion).toBeNull();
    expect(summary.liveCycles).toHaveLength(1);
    expect(summary.liveCycles[0]).toMatchObject({ considered: 0, submitted: 0, halted: false });
  });
});

function testConfig(dbPath: string, lockPath: string): Config {
  return {
    ...DEFAULT_CONFIG,
    chainId: 137,
    sourceWallets: [leader],
    rpcProviders: [
      { name: "primary", url: "https://polygon.example/primary", maxLagMs: 30_000, maxLagBlocks: 1 },
      { name: "fallback", url: "https://polygon.example/fallback", maxLagMs: 30_000, maxLagBlocks: 1 }
    ],
    account: {
      walletMode: "EOA",
      signatureType: 0,
      ownerSignerAddress: owner,
      orderMakerAddress: owner,
      orderSignerAddress: owner,
      funderAddress: owner
    },
    runtime: {
      ...DEFAULT_CONFIG.runtime,
      dbPath,
      lockPath
    },
    live: {
      enabled: true,
      maxOneLiveOrder: true,
      ciTinyBudgetPusdRaw: "5000000"
    }
  } as Config;
}

function fixedSigner(): LiveOrderSigner {
  return {
    async signMarketOrder() {
      throw new Error("not reached in empty submit-only cycle");
    }
  };
}
