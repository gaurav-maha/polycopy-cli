import { join } from "node:path";

export const DEFAULT_CONFIG_PATH = "~/.config/polycopy/config.json";

export const DEFAULT_CONFIG = {
  chainId: 137,
  sourceWallets: [],
  leaders: {},
  rpcProviders: [],
  account: {
    walletMode: "EOA",
    signatureType: 0,
    ownerSignerAddress: undefined,
    orderMakerAddress: undefined,
    orderSignerAddress: undefined,
    funderAddress: undefined
  },
  copy: {
    enableSell: false
  },
  risk: {
    copyPct: "0.10",
    maxTradePusdRaw: undefined,
    maxDailySpendPusdRaw: undefined,
    maxMarketPositionPusdRaw: undefined,
    freeBudgetPusdRaw: undefined,
    maxTradesPerDay: undefined,
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
    dataDir: "./.polycopy",
    dbPath: "./.polycopy/polycopy.db",
    logDir: "./.polycopy/logs",
    killSwitchPath: "./.polycopy/kill.switch",
    lockPath: join("./.polycopy", "polycopy.lock"),
    confirmationDepth: 2,
    aggregationWindowBlocks: 2,
    confirmedLogMaxDelayMs: 120_000,
    polygonBlockTimeMs: 2_000,
    reorgLookbackBlocks: 64,
    maxRecoveryAttempts: 5,
    maxPendingSubmissions: 32,
    clockSkewMaxMs: 3_000,
    secretsPath: undefined
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
    enabled: false,
    maxOneLiveOrder: true,
    credentialLabel: undefined,
    ciTinyBudgetPusdRaw: "5000000"
  }
} as const;
