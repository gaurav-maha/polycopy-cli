import { Command, Option } from "commander";
import type { ApiKeyCreds } from "@polymarket/clob-client-v2";
import { createOrDeriveClobCredentials, readClobCredentials } from "../../account/clob-auth.js";
import { createRelayerApiKeyWithGammaAuth } from "../../account/relayer-auth.js";
import { buildAccountSetupPlan, assertSetupAccountExecutionSupported } from "../../account/setup-plan.js";
import { executeEoaSetup } from "../../account/setup-eoa.js";
import {
  createHttpPoly1271Relayer,
  deriveDepositWalletAddress,
  executePoly1271Setup,
  syncPoly1271ClobBalance,
  type RelayerAuth
} from "../../account/setup-poly1271.js";
import { applyPoly1271Wallet } from "../../config/account-set.js";
import { accountFromPrivateKey } from "../../config/copytrade-config.js";
import type { AccountConfig, WalletMode } from "../../config/schema.js";
import { walletModeSchema } from "../../config/schema.js";
import { loadPrivateKeyFromEnv } from "../../config/live-secrets.js";
import { loadConfig } from "../../config/load.js";
import { writeConfigFile } from "../../config/persist.js";
import { resolveRpcUrl } from "../../config/rpc-persist.js";
import { resolveSecretsPath } from "../../config/secrets-path.js";
import { parseUsdAmountRaw } from "../../config/user-input.js";
import { readWalletFile, writeWalletFile } from "../../config/wallet-file.js";
import { EXIT_CODES } from "../../errors/exit-codes.js";
import { resolveCliConfigPath } from "../config-path.js";

export function registerSetupAccount(program: Command): void {
  program
    .command("setup-account")
    .description("Inspect or execute live deposit-wallet setup")
    .option("--execute", "send setup transactions when supported")
    .option("--enable-sell", "include ERC-1155 sell approval checks")
    .option("--secrets <path>", "wallet env file with PRIVATE_KEY")
    .option("--usd <amount>", "target usable trading collateral in USD")
    .option("--approve-max", "approve maximum pUSD allowance instead of the target amount")
    .addOption(new Option("--wallet-mode <mode>", "advanced: setup wallet mode override").hideHelp())
    .option("--relayer-url <url>", "Polymarket relayer URL", "https://relayer-v2.polymarket.com")
    .option("--init-relayer-auth", "create a relayer API key from the EOA if the wallet file has none")
    .option("--gamma-url <url>", "Gamma API URL for --init-relayer-auth", "https://gamma-api.polymarket.com")
    .option("--no-wait-relayer", "do not wait for relayer transactions to mine/confirm")
    .option("--deadline-seconds <seconds>", "deposit-wallet approval batch signature lifetime", "1200")
    .action(async (options: {
      execute?: boolean;
      enableSell?: boolean;
      secrets?: string;
      usd?: string;
      approveMax?: boolean;
      walletMode?: string;
      relayerUrl?: string;
      initRelayerAuth?: boolean;
      gammaUrl?: string;
      waitRelayer?: boolean;
      deadlineSeconds?: string;
    }) => {
      const execute = options.execute === true;
      try {
        const rpcUrl = await resolveRpcUrl();
        const configPath = resolveCliConfigPath(program);
        const baseConfig = await loadConfig({ command: "setup-account", configPath });
        const secretsPath = resolveSecretsPath({ explicit: options.secrets, config: baseConfig });
        const privateKey = await loadPrivateKeyFromEnv(secretsPath);
        const privateKeyAccount = accountFromPrivateKey(privateKey);
        const ownerAddress = privateKeyAccount.ownerSignerAddress!;
        const requestedWalletMode = resolveRequestedSetupWalletMode(options.walletMode);
        const account = resolveSetupAccount(baseConfig.account, privateKeyAccount, requestedWalletMode);
        const targetCollateralRaw = options.usd === undefined ? undefined : BigInt(parseUsdAmountRaw(options.usd));
        const config = await loadConfig({
          command: "setup-account",
          configPath,
          overrides: {
            account,
            copy: { enableSell: options.enableSell === true },
            rpcProviders: [{ name: "primary", url: rpcUrl, maxLagMs: 30_000, maxLagBlocks: 1 }]
          }
        });
        const plan = buildAccountSetupPlan({
          account: config.account,
          copy: config.copy,
          execute: false,
          targetCollateralRaw
        });

        if (execute) {
          try {
            assertSetupAccountExecutionSupported(config.account);
          } catch (error) {
            emitSetupAccountFailure(
              {
                error: "UNSUPPORTED_WALLET_MODE",
                reason: error instanceof Error ? error.message : String(error),
                plan
              },
              EXIT_CODES.NOT_IMPLEMENTED
            );
          }

          if (config.account.walletMode === "POLY_1271") {
            const walletValues = await readWalletFile(secretsPath);
            const clobCreds = await resolveClobCredentials({
              walletValues,
              privateKey,
              rpcUrl
            });
            const relayerAuth = await resolveRelayerAuth({
              walletValues: clobCreds.walletValues,
              env: process.env,
              ownerAddress,
              privateKey,
              init: options.initRelayerAuth === true,
              gammaUrl: options.gammaUrl,
              relayerUrl: options.relayerUrl,
              secretsPath
            });
            const result = await executePoly1271Setup({
              account: config.account,
              copy: config.copy,
              privateKey,
              rpcUrl,
              targetCollateralRaw,
              approveMax: options.approveMax === true,
              relayer: createHttpPoly1271Relayer({
                auth: relayerAuth.auth,
                url: options.relayerUrl
              }),
              syncClob: async (account) => {
                await syncPoly1271ClobBalance({
                  privateKey,
                  rpcUrl,
                  creds: clobCreds.creds,
                  funder: account.funderAddress!
                });
              },
              waitForRelayer: options.waitRelayer !== false,
              deadlineSeconds: parsePositiveIntegerOption(options.deadlineSeconds ?? "1200", "deadline-seconds")
            });
            if (result.ok) {
              if (clobCreds.created || relayerAuth.created) {
                await writeWalletFile(secretsPath, relayerAuth.walletValues, { overwrite: true });
              }
              baseConfig.account = result.account;
              baseConfig.copy.enableSell = config.copy.enableSell;
              baseConfig.runtime.secretsPath = secretsPath;
              await writeConfigFile(configPath, baseConfig);
            }
            process.stdout.write(`${JSON.stringify({ command: "setup-account", wallet: ownerAddress, ...result })}\n`);
            if (!result.ok) process.exit(EXIT_CODES.USAGE_OR_CONFIG);
            return;
          }

          const result = await executeEoaSetup({
            account: config.account,
            copy: config.copy,
            rpcUrl,
            targetCollateralRaw,
            approveMax: options.approveMax === true,
            envFile: secretsPath
          });
          process.stdout.write(`${JSON.stringify({ command: "setup-account", wallet: ownerAddress, ...result })}\n`);
          if (!result.ok) process.exit(EXIT_CODES.USAGE_OR_CONFIG);
          if (options.secrets) {
            baseConfig.runtime.secretsPath = secretsPath;
            await writeConfigFile(configPath, baseConfig);
          }
          return;
        }

        if (options.secrets) {
          baseConfig.runtime.secretsPath = secretsPath;
          await writeConfigFile(configPath, baseConfig);
        }
        process.stdout.write(
          `${JSON.stringify({ ok: true, command: "setup-account", wallet: ownerAddress, plan })}\n`
        );
      } catch (error) {
        emitSetupAccountFailure(
          {
            error: (error as { code?: string }).code ?? "ACCOUNT_SETUP_FAILED",
            reason: error instanceof Error ? error.message : String(error)
          },
          EXIT_CODES.USAGE_OR_CONFIG
        );
      }
    });
}

export function resolveSetupAccount(
  configuredAccount: AccountConfig,
  privateKeyAccount: AccountConfig,
  requestedWalletMode: WalletMode | undefined
): AccountConfig {
  const owner = privateKeyAccount.ownerSignerAddress!;
  if (requestedWalletMode === "POLY_1271") {
    if (configuredAccount.walletMode === "POLY_1271") {
      assertPrivateKeyMatchesConfiguredOwner(configuredAccount, privateKeyAccount);
    }
    return applyPoly1271Wallet(configuredAccount, { owner, contract: deriveDepositWalletAddress(owner) });
  }
  if (requestedWalletMode === "EOA") {
    return privateKeyAccount;
  }
  if (requestedWalletMode === "POLY_PROXY") {
    throw new Error("setup-account --wallet-mode POLY_PROXY is not implemented");
  }

  if (configuredAccount.walletMode === "EOA") {
    return privateKeyAccount;
  }
  if (configuredAccount.walletMode === "POLY_1271") {
    assertPrivateKeyMatchesConfiguredOwner(configuredAccount, privateKeyAccount);
    return applyPoly1271Wallet(configuredAccount, { owner, contract: deriveDepositWalletAddress(owner) });
  }
  assertPrivateKeyMatchesConfiguredOwner(configuredAccount, privateKeyAccount);
  return configuredAccount;
}

function assertPrivateKeyMatchesConfiguredOwner(
  configuredAccount: AccountConfig,
  privateKeyAccount: AccountConfig
): void {
  const ownerSignerAddress = configuredAccount.ownerSignerAddress;
  if (!ownerSignerAddress) {
    throw new Error(`${configuredAccount.walletMode} setup-account requires configured ownerSignerAddress`);
  }
  const privateKeyOwner = privateKeyAccount.ownerSignerAddress!;
  if (ownerSignerAddress.toLowerCase() !== privateKeyOwner.toLowerCase()) {
    throw new Error("PRIVATE_KEY does not match configured ownerSignerAddress");
  }
}

export function resolveRequestedSetupWalletMode(input: string | undefined): WalletMode | undefined {
  if (input) {
    return parseWalletMode(input);
  }
  return "POLY_1271";
}

function parseWalletMode(input: string): WalletMode {
  const normalized = input.trim().toUpperCase().replaceAll("-", "_");
  const compact = normalized.replaceAll("_", "");
  if (compact === "POLY1271") return "POLY_1271";
  if (compact === "POLYPROXY") return "POLY_PROXY";
  return walletModeSchema.parse(normalized);
}

type ResolvedClobCredentials = {
  creds: ApiKeyCreds;
  walletValues: Record<string, string>;
  created: boolean;
};

type ResolvedRelayerAuth = {
  auth: RelayerAuth | undefined;
  walletValues: Record<string, string>;
  created: boolean;
};

async function resolveClobCredentials(args: {
  walletValues: Record<string, string>;
  privateKey: `0x${string}`;
  rpcUrl: string;
}): Promise<ResolvedClobCredentials> {
  const existing = readClobCredentials(args.walletValues);
  if (existing) {
    return { creds: existing, walletValues: args.walletValues, created: false };
  }
  const credentials = await createOrDeriveClobCredentials({ privateKey: args.privateKey, rpcUrl: args.rpcUrl });
  return {
    creds: credentials,
    walletValues: {
      ...args.walletValues,
      PRIVATE_KEY: args.privateKey,
      CLOB_API_KEY: credentials.key,
      CLOB_SECRET: credentials.secret,
      CLOB_PASS_PHRASE: credentials.passphrase
    },
    created: true
  };
}

function readRelayerAuth(values: Record<string, string>, env: NodeJS.ProcessEnv, ownerAddress: string): RelayerAuth | undefined {
  const relayerApiKey = readSecret(values, env, "RELAYER_API_KEY");
  if (relayerApiKey) {
    return {
      kind: "relayer",
      apiKey: relayerApiKey,
      address: readSecret(values, env, "RELAYER_API_KEY_ADDRESS") ?? ownerAddress
    };
  }

  const builderKey = readSecret(values, env, "POLY_BUILDER_API_KEY") ?? readSecret(values, env, "BUILDER_API_KEY");
  const builderSecret = readSecret(values, env, "POLY_BUILDER_SECRET") ?? readSecret(values, env, "BUILDER_SECRET");
  const builderPassphrase =
    readSecret(values, env, "POLY_BUILDER_PASS_PHRASE") ??
    readSecret(values, env, "POLY_BUILDER_PASSPHRASE") ??
    readSecret(values, env, "BUILDER_PASS_PHRASE") ??
    readSecret(values, env, "BUILDER_PASSPHRASE");
  if (builderKey && builderSecret && builderPassphrase) {
    return { kind: "builder", key: builderKey, secret: builderSecret, passphrase: builderPassphrase };
  }
  return undefined;
}

async function resolveRelayerAuth(args: {
  walletValues: Record<string, string>;
  env: NodeJS.ProcessEnv;
  ownerAddress: string;
  privateKey: `0x${string}`;
  init: boolean;
  gammaUrl?: string;
  relayerUrl?: string;
  secretsPath: string;
}): Promise<ResolvedRelayerAuth> {
  const existing = readRelayerAuth(args.walletValues, args.env, args.ownerAddress);
  if (existing || !args.init) {
    return { auth: existing, walletValues: args.walletValues, created: false };
  }
  const key = await createRelayerApiKeyWithGammaAuth({
    privateKey: args.privateKey,
    gammaUrl: args.gammaUrl,
    relayerUrl: args.relayerUrl
  });
  const walletValues = {
    ...args.walletValues,
    PRIVATE_KEY: args.privateKey,
    RELAYER_API_KEY: key.apiKey,
    RELAYER_API_KEY_ADDRESS: key.address
  };
  await writeWalletFile(args.secretsPath, walletValues, { overwrite: true });
  return {
    auth: { kind: "relayer", apiKey: key.apiKey, address: key.address },
    walletValues,
    created: true
  };
}

function readSecret(values: Record<string, string>, env: NodeJS.ProcessEnv, key: string): string | undefined {
  return values[key]?.trim() || env[key]?.trim() || undefined;
}

function parsePositiveIntegerOption(raw: string, option: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`--${option} must be a positive integer`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`--${option} must be a positive integer`);
  }
  return parsed;
}

function emitSetupAccountFailure(payload: Record<string, unknown>, exitCode: number): never {
  process.stdout.write(`${JSON.stringify({ ok: false, command: "setup-account", ...payload })}\n`);
  process.exit(exitCode);
}
