import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "../adapters/types.js";
import { applyEoaWallet } from "./account-set.js";
import { DEFAULT_CONFIG } from "./defaults.js";
import { loadConfig } from "./load.js";
import { rpcProvidersFromUrls } from "./rpc-persist.js";
import { normalizeCopyPct, parseUsdAmountRaw } from "./user-input.js";
import type { Config } from "./schema.js";
import type { HexAddress } from "./leaders.js";

export type BuildConfigArgs = {
  command: string;
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  leaders?: HexAddress[];
  rpcUrls?: string[];
  copyPct?: string;
  budgetUsd?: string;
  maxTradeSizeUsd?: string;
  enableSell?: boolean;
  walletAddress?: HexAddress;
  live?: boolean;
  dbPath?: string;
  logDir?: string;
  dataDir?: string;
};

export function accountFromPrivateKey(privateKey: Hex) {
  return applyEoaWallet({ ...DEFAULT_CONFIG.account }, privateKeyToAccount(privateKey).address);
}

export async function buildConfig(args: BuildConfigArgs): Promise<Config> {
  const overrides: Partial<Config> = {};

  if (args.leaders) {
    overrides.sourceWallets = args.leaders;
  }
  if (args.rpcUrls) {
    overrides.rpcProviders = rpcProvidersFromUrls(args.rpcUrls);
  }
  if (args.live !== undefined) {
    overrides.live = {
      ...DEFAULT_CONFIG.live,
      enabled: args.live === true,
      maxOneLiveOrder: true,
      ciTinyBudgetPusdRaw: "5000000"
    };
  }
  if (args.copyPct) {
    overrides.risk = { ...DEFAULT_CONFIG.risk, copyPct: normalizeCopyPct(args.copyPct) };
  }
  if (args.budgetUsd || args.maxTradeSizeUsd) {
    overrides.risk = {
      ...(overrides.risk ?? DEFAULT_CONFIG.risk),
      ...(args.budgetUsd ? { freeBudgetPusdRaw: parseUsdAmountRaw(args.budgetUsd) } : {}),
      ...(args.maxTradeSizeUsd ? { maxTradePusdRaw: parseUsdAmountRaw(args.maxTradeSizeUsd) } : {})
    };
  }
  if (args.enableSell !== undefined) {
    overrides.copy = { enableSell: args.enableSell };
  }
  if (args.walletAddress) {
    overrides.account = applyEoaWallet({ ...DEFAULT_CONFIG.account }, args.walletAddress);
  }

  const runtime: Partial<Config["runtime"]> = {};
  if (args.dataDir) runtime.dataDir = args.dataDir;
  if (args.dbPath) runtime.dbPath = args.dbPath;
  if (args.logDir) runtime.logDir = args.logDir;
  if (Object.keys(runtime).length > 0) {
    overrides.runtime = { ...DEFAULT_CONFIG.runtime, ...runtime };
  }

  return loadConfig({
    command: args.command,
    configPath: args.configPath,
    env: args.env,
    overrides
  });
}
