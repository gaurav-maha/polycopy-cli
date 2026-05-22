import { z } from "zod";

export const MAX_LEADERS = 10;

export const hexAddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const rawAmountSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
const ppmSchema = z.number().int().min(0).max(1_000_000);
const bpsSchema = z.number().int().min(0).max(10_000);

export const walletModeSchema = z.enum(["EOA", "POLY_PROXY", "POLY_1271"]);
export type WalletMode = z.infer<typeof walletModeSchema>;

export const accountConfigSchema = z
  .object({
    walletMode: walletModeSchema,
    signatureType: z.union([z.literal(0), z.literal(1), z.literal(3)]),
    ownerSignerAddress: hexAddressSchema.optional(),
    orderMakerAddress: hexAddressSchema.optional(),
    orderSignerAddress: hexAddressSchema.optional(),
    funderAddress: hexAddressSchema.optional()
  })
  .superRefine((account, ctx) => {
    const expectedSignatureType = account.walletMode === "EOA" ? 0 : account.walletMode === "POLY_PROXY" ? 1 : 3;
    if (account.signatureType !== expectedSignatureType) {
      ctx.addIssue({
        code: "custom",
        message: `${account.walletMode} requires signatureType ${expectedSignatureType}`,
        path: ["signatureType"]
      });
    }
    const addresses = [
      account.ownerSignerAddress,
      account.orderMakerAddress,
      account.orderSignerAddress,
      account.funderAddress
    ];
    if (addresses.some(Boolean) && addresses.some((value) => !value)) {
      ctx.addIssue({
        code: "custom",
        message: "account addresses must be provided together",
        path: ["ownerSignerAddress"]
      });
      return;
    }
    if (!addresses.every(Boolean)) {
      return;
    }
    if (account.walletMode === "EOA") {
      const unique = new Set(addresses.map((address) => address?.toLowerCase()));
      if (unique.size !== 1) {
        ctx.addIssue({ code: "custom", message: "EOA mode requires all account addresses to match" });
      }
    }
    if (account.walletMode === "POLY_PROXY") {
      if (account.ownerSignerAddress?.toLowerCase() !== account.orderSignerAddress?.toLowerCase()) {
        ctx.addIssue({ code: "custom", message: "POLY_PROXY requires ownerSignerAddress == orderSignerAddress" });
      }
      if (account.orderMakerAddress?.toLowerCase() !== account.funderAddress?.toLowerCase()) {
        ctx.addIssue({ code: "custom", message: "POLY_PROXY requires orderMakerAddress == funderAddress" });
      }
    }
    if (account.walletMode === "POLY_1271") {
      const unique = new Set([
        account.orderMakerAddress?.toLowerCase(),
        account.orderSignerAddress?.toLowerCase(),
        account.funderAddress?.toLowerCase()
      ]);
      if (unique.size !== 1) {
        ctx.addIssue({
          code: "custom",
          message: "POLY_1271 requires orderMakerAddress == orderSignerAddress == funderAddress"
        });
      }
    }
  });

export type AccountConfig = z.infer<typeof accountConfigSchema>;

export const leaderProfileSchema = z.object({
  copyPct: z.string().regex(/^(0?(\.[0-9]+)?|1(\.0+)?)$/).optional(),
  maxDailySpendPusdRaw: rawAmountSchema.optional(),
  enabled: z.boolean().default(true).optional()
});

export type LeaderProfile = z.infer<typeof leaderProfileSchema>;

export const rpcProviderSchema = z.object({
  name: z.union([z.literal("primary"), z.literal("fallback"), z.string().regex(/^fallback-[2-9]\d*$/)]),
  url: z.string().min(1),
  maxLagMs: z.number().int().positive().default(30_000),
  maxLagBlocks: z.number().int().nonnegative().default(1)
});

export const configSchema = z
  .object({
  chainId: z.literal(137),
  sourceWallets: z.array(hexAddressSchema).max(MAX_LEADERS),
  leaders: z.record(hexAddressSchema, leaderProfileSchema).optional(),
  rpcProviders: z.array(rpcProviderSchema),
  account: accountConfigSchema,
  copy: z.object({
    enableSell: z.boolean().default(false)
  }),
  risk: z.object({
    copyPct: z.string().regex(/^(0?(\.[0-9]+)?|1(\.0+)?)$/),
    maxTradePusdRaw: rawAmountSchema.optional(),
    maxDailySpendPusdRaw: rawAmountSchema.optional(),
    maxMarketPositionPusdRaw: rawAmountSchema.optional(),
    freeBudgetPusdRaw: rawAmountSchema.optional(),
    maxTradesPerDay: z.number().int().positive().optional(),
    maxBookParticipationBps: bpsSchema,
    maxTradeFractionOfBudgetBps: bpsSchema,
    maxSpreadPpm: ppmSchema,
    maxDriftPpm: ppmSchema,
    maxBuyPpm: ppmSchema,
    minSellPpm: ppmSchema,
    slippageCapPpm: ppmSchema,
    consecutiveRejectionsHalt: z.number().int().positive(),
    consecutiveTimeoutUnknownHalt: z.number().int().positive(),
    staleBookHalt: z.number().int().positive(),
    bookSourceMismatchHalt: z.number().int().positive(),
    clobUnavailableHalt: z.number().int().positive()
  }),
  runtime: z.object({
    dataDir: z.string().min(1),
    dbPath: z.string().min(1),
    logDir: z.string().min(1),
    killSwitchPath: z.string().min(1),
    lockPath: z.string().min(1),
    confirmationDepth: z.number().int().min(2).default(2),
    aggregationWindowBlocks: z.number().int().min(0),
    confirmedLogMaxDelayMs: z.number().int().positive(),
    polygonBlockTimeMs: z.number().int().positive(),
    reorgLookbackBlocks: z.number().int().positive(),
    maxRecoveryAttempts: z.number().int().positive(),
    maxPendingSubmissions: z.number().int().positive(),
    clockSkewMaxMs: z.number().int().positive(),
    secretsPath: z.string().min(1).optional()
  }),
  market: z.object({
    metadataMaxAgeMs: z.number().int().positive(),
    metadataRestCrossCheckMaxAgeMs: z.number().int().positive(),
    bookRestCrossCheckMaxAgeMs: z.number().int().positive(),
    maxBookAgeMs: z.number().int().positive(),
    wsStaleMs: z.number().int().positive(),
    restStaleMs: z.number().int().positive(),
    bookMismatchPpm: ppmSchema,
    maxPositionAgeMs: z.number().int().positive(),
    clobCacheMaxAgeMs: z.number().int().positive(),
    onchainBalanceMaxAgeMs: z.number().int().positive(),
    balanceMismatchToleranceRaw: rawAmountSchema,
    orderTypeFOKForFullSize: z.boolean()
  }),
  live: z.object({
    enabled: z.boolean().default(false),
    maxOneLiveOrder: z.boolean().default(true),
    credentialLabel: z.string().min(1).optional(),
    ciTinyBudgetPusdRaw: rawAmountSchema
  })
})
  .superRefine((config, ctx) => {
    if (config.sourceWallets.length > MAX_LEADERS) {
      ctx.addIssue({
        code: "custom",
        message: `sourceWallets supports at most ${MAX_LEADERS} addresses`,
        path: ["sourceWallets"]
      });
    }
  });

export type Config = z.infer<typeof configSchema>;
