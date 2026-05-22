import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execaNode } from "../helpers/execa-node.js";

const privateKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const eoa = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const depositWallet = "0x3333333333333333333333333333333333333333";

describe("live command safety shell", () => {
  let dir: string;
  let configPath: string;
  let envPath: string;
  let killSwitchPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "polycopy-live-"));
    configPath = join(dir, "config.json");
    envPath = join(dir, ".env");
    killSwitchPath = join(dir, "kill.switch");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeConfig(overrides: Record<string, unknown> = {}) {
    const config = {
      chainId: 137,
      sourceWallets: ["0x9d84ce0306f8551e02efef1680475fc0f1dc1344"],
      rpcProviders: [
        { name: "primary", url: "https://polygon.example/primary", maxLagMs: 30000, maxLagBlocks: 1 },
        { name: "fallback", url: "https://polygon.example/fallback", maxLagMs: 30000, maxLagBlocks: 1 }
      ],
      account: {
        walletMode: "POLY_1271",
        signatureType: 3,
        ownerSignerAddress: eoa,
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
        maxSpreadPpm: 80000,
        maxDriftPpm: 30000,
        maxBuyPpm: 980000,
        minSellPpm: 20000,
        slippageCapPpm: 50000,
        consecutiveRejectionsHalt: 5,
        consecutiveTimeoutUnknownHalt: 3,
        staleBookHalt: 5,
        bookSourceMismatchHalt: 3,
        clobUnavailableHalt: 3
      },
      runtime: {
        dataDir: dir,
        dbPath: join(dir, "polycopy.db"),
        logDir: join(dir, "logs"),
        killSwitchPath,
        lockPath: join(dir, "polycopy.lock"),
        confirmationDepth: 2,
        aggregationWindowBlocks: 2,
        confirmedLogMaxDelayMs: 120000,
        polygonBlockTimeMs: 2000,
        reorgLookbackBlocks: 64,
        maxRecoveryAttempts: 5,
        maxPendingSubmissions: 32,
        clockSkewMaxMs: 3000
      },
      market: {
        metadataMaxAgeMs: 60000,
        metadataRestCrossCheckMaxAgeMs: 300000,
        bookRestCrossCheckMaxAgeMs: 1500,
        maxBookAgeMs: 800,
        wsStaleMs: 500,
        restStaleMs: 1500,
        bookMismatchPpm: 100000,
        maxPositionAgeMs: 300000,
        clobCacheMaxAgeMs: 60000,
        onchainBalanceMaxAgeMs: 120000,
        balanceMismatchToleranceRaw: "0",
        orderTypeFOKForFullSize: false
      },
      live: {
        enabled: true,
        maxOneLiveOrder: true,
        credentialLabel: "ci-tiny-test",
        ciTinyBudgetPusdRaw: "5000000"
      },
      ...overrides
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(envPath, `PRIVATE_KEY=${privateKey}\nCLOB_API_KEY=test-key\nCLOB_SECRET=test-secret\nCLOB_PASS_PHRASE=test-pass\n`, {
      mode: 0o600
    });
    await chmod(envPath, 0o600);
  }

  it("refuses live when live.enabled is false", async () => {
    await writeConfig({ live: { enabled: false, maxOneLiveOrder: true, credentialLabel: "ci-tiny-test", ciTinyBudgetPusdRaw: "5000000" } });
    const result = await execaNode(["--json", "live"], {
      reject: false,
      configPath
    });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: "LIVE_NOT_ENABLED" });
  });

  it("kill switch blocks live before any submission path", async () => {
    await writeConfig();
    await writeFile(killSwitchPath, "on\n");
    const result = await execaNode(["--json", "live"], {
      reject: false,
      configPath,
      env: { LIVE_TEST_CI: "1" }
    });
    expect(result.exitCode).toBe(4);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: "KILL_SWITCH_ACTIVE" });
  });

  it("refuses EOA live submission because CLOB requires a deposit or proxy wallet", async () => {
    await writeConfig({
      account: {
        walletMode: "EOA",
        signatureType: 0,
        ownerSignerAddress: eoa,
        orderMakerAddress: eoa,
        orderSignerAddress: eoa,
        funderAddress: eoa
      }
    });
    const result = await execaNode(["--json", "live"], {
      reject: false,
      configPath,
      env: { LIVE_TEST_CI: "1" }
    });
    expect(result.exitCode).toBe(5);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: "UNSUPPORTED_WALLET_MODE"
    });
    expect(JSON.parse(result.stdout).reason).toMatch(/configure POLY_1271 or POLY_PROXY/);
  });

  it("reports the exact missing live wallet file path", async () => {
    await writeConfig();
    const missingPath = join(dir, "missing-wallet.env");

    const result = await execaNode(["--json", "live", "--secrets", missingPath], {
      reject: false,
      configPath,
      env: { LIVE_TEST_CI: "1" }
    });

    expect(result.exitCode).toBe(1);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({ ok: false, error: "COPYTRADE_FAILED" });
    expect(payload.reason).toContain(missingPath);
    expect(payload.reason).toContain("PRIVATE_KEY");
    expect(payload.reason).toContain("CLOB_API_KEY");
  });

  it("passes double opt-in gates in constrained CI and runs an empty live cycle", async () => {
    await writeConfig();
    const result = await execaNode(["--json", "live", "--secrets", envPath], {
      reject: false,
      configPath,
      env: { LIVE_TEST_CI: "1" }
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      command: "live",
      summary: { cycles: 1, considered: 0, submitted: 0 }
    });
  });
});
