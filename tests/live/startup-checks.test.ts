import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockClock, MockRpcAdapter } from "../../src/adapters/mocks.js";
import type { Hex } from "../../src/adapters/types.js";
import type { Config } from "../../src/config/schema.js";
import { assertLiveStartupReady } from "../../src/live/startup-checks.js";
import { createMigratedTempDb, type TempDb } from "../helpers/temp-db.js";

const owner = "0x1111111111111111111111111111111111111111";
const depositWallet = "0x3333333333333333333333333333333333333333";

describe("live startup checks", () => {
  let dir: string;
  let tempDb: TempDb | undefined;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "polycopy-startup-")));
    tempDb = await createMigratedTempDb();
  });

  afterEach(async () => {
    await tempDb?.cleanup();
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects a POLY_1271 deposit wallet address with no on-chain code", async () => {
    const { config, configPath, envPath } = await writeLiveFiles(dir, poly1271Config(dir));
    const rpc = new MockRpcAdapter({
      clock: new MockClock(Date.UTC(2026, 4, 22)),
      codes: { [depositWallet]: "0x" }
    });

    await expect(
      assertLiveStartupReady({
        config,
        configPath,
        envPath,
        db: tempDb!.db,
        primaryRpc: rpc,
        fallbackRpc: rpc,
        skipRpcHealth: true
      })
    ).rejects.toThrow(/POLY_1271 deposit wallet has no on-chain code/);
  });
});

async function writeLiveFiles(dir: string, config: Config): Promise<{ config: Config; configPath: string; envPath: string }> {
  await mkdir(config.runtime.dataDir, { recursive: true, mode: 0o700 });
  await mkdir(config.runtime.logDir, { recursive: true, mode: 0o700 });
  const configPath = join(dir, "config.json");
  const envPath = join(dir, "wallet.env");
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(configPath, 0o600);
  await writeFile(envPath, `PRIVATE_KEY=0x${"a".repeat(64)}\n`, { mode: 0o600 });
  await chmod(envPath, 0o600);
  return { config, configPath, envPath };
}

function poly1271Config(dir: string): Config {
  return {
    chainId: 137,
    sourceWallets: [owner],
    leaders: {},
    rpcProviders: [
      { name: "primary", url: "https://polygon.example/primary", maxLagMs: 30_000, maxLagBlocks: 1 },
      { name: "fallback", url: "https://polygon.example/fallback", maxLagMs: 30_000, maxLagBlocks: 1 }
    ],
    account: {
      walletMode: "POLY_1271",
      signatureType: 3,
      ownerSignerAddress: owner,
      orderMakerAddress: depositWallet,
      orderSignerAddress: depositWallet,
      funderAddress: depositWallet
    },
    copy: { enableSell: false },
    risk: {
      copyPct: "0.10",
      maxTradePusdRaw: "1000000",
      maxDailySpendPusdRaw: "1000000",
      maxMarketPositionPusdRaw: "1000000",
      freeBudgetPusdRaw: "1000000",
      maxTradesPerDay: 1,
      maxBookParticipationBps: 1500,
      maxTradeFractionOfBudgetBps: 5000,
      maxSpreadPpm: 80_000,
      maxDriftPpm: 30_000,
      maxBuyPpm: 980_000,
      minSellPpm: 20_000,
      slippageCapPpm: 50_000,
      consecutiveRejectionsHalt: 5,
      consecutiveTimeoutUnknownHalt: 3,
      staleBookHalt: 5,
      bookSourceMismatchHalt: 3,
      clobUnavailableHalt: 3
    },
    runtime: {
      dataDir: join(dir, "data"),
      dbPath: join(dir, "polycopy.db"),
      logDir: join(dir, "logs"),
      killSwitchPath: join(dir, "kill.switch"),
      lockPath: join(dir, "polycopy.lock"),
      confirmationDepth: 2,
      aggregationWindowBlocks: 2,
      confirmedLogMaxDelayMs: 120_000,
      polygonBlockTimeMs: 2_000,
      reorgLookbackBlocks: 64,
      maxRecoveryAttempts: 5,
      maxPendingSubmissions: 32,
      clockSkewMaxMs: 3_000
    },
    market: {
      metadataMaxAgeMs: 60_000,
      metadataRestCrossCheckMaxAgeMs: 300_000,
      bookRestCrossCheckMaxAgeMs: 1_500,
      maxBookAgeMs: 800,
      wsStaleMs: 500,
      restStaleMs: 1_500,
      bookMismatchPpm: 100_000,
      maxPositionAgeMs: 300_000,
      clobCacheMaxAgeMs: 60_000,
      onchainBalanceMaxAgeMs: 120_000,
      balanceMismatchToleranceRaw: "0",
      orderTypeFOKForFullSize: false
    },
    live: {
      enabled: true,
      maxOneLiveOrder: true,
      credentialLabel: "ci-tiny-test",
      ciTinyBudgetPusdRaw: "5000000"
    }
  };
}
