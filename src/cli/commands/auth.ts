import { Command } from "commander";
import { privateKeyToAccount } from "viem/accounts";
import { createOrDeriveClobCredentials, readClobCredentials } from "../../account/clob-auth.js";
import { createRelayerApiKeyWithGammaAuth } from "../../account/relayer-auth.js";
import { EXIT_CODES } from "../../errors/exit-codes.js";
import { loadConfig } from "../../config/load.js";
import { resolveSecretsPath } from "../../config/secrets-path.js";
import { parsePrivateKey, readWalletFile, writeWalletFile } from "../../config/wallet-file.js";
import { resolveCliConfigPath } from "../config-path.js";

type AuthInitOptions = {
  secrets?: string;
  force?: boolean;
};

type RelayerInitOptions = AuthInitOptions & {
  gammaUrl?: string;
  relayerUrl?: string;
};

export function registerAuth(program: Command): void {
  const auth = program.command("auth").description("Manage Polymarket CLOB authentication");

  auth
    .command("init")
    .description("Create or derive CLOB API credentials for the configured wallet")
    .option("--secrets <path>", "wallet env file override")
    .option("--force", "replace existing CLOB credentials")
    .action(async (options: AuthInitOptions) => {
      try {
        const config = await loadConfig({ command: "auth", configPath: resolveCliConfigPath(program) });
        const secretsPath = resolveSecretsPath({ explicit: options.secrets, config });
        const values = await readWalletFile(secretsPath);
        if (!options.force) {
          const existing = readClobCredentials(values);
          if (existing) {
            emit(program, { ok: true, command: "auth init", walletFile: secretsPath, created: false });
            return;
          }
        }
        const privateKey = parsePrivateKey(required(values, "PRIVATE_KEY"));
        const account = privateKeyToAccount(privateKey);
        const primaryRpc = config.rpcProviders.find((provider) => provider.name === "primary")?.url;
        if (!primaryRpc) {
          throw new Error("auth init requires rpc primary url; run polycopy rpc set <url>");
        }
        const credentials = await createOrDeriveClobCredentials({ privateKey, rpcUrl: primaryRpc });
        await writeWalletFile(
          secretsPath,
          {
            ...values,
            PRIVATE_KEY: privateKey,
            CLOB_API_KEY: credentials.key,
            CLOB_SECRET: credentials.secret,
            CLOB_PASS_PHRASE: credentials.passphrase
          },
          { overwrite: true }
        );
        emit(program, { ok: true, command: "auth init", walletFile: secretsPath, address: account.address, created: true });
      } catch (error) {
        emitFailure(program, {
          ok: false,
          command: "auth init",
          error: "AUTH_INIT_FAILED",
          reason: error instanceof Error ? error.message : String(error)
        });
      }
    });

  auth
    .command("relayer-init")
    .description("Create a relayer API key from the configured EOA wallet")
    .option("--secrets <path>", "wallet env file override")
    .option("--force", "replace existing relayer API key")
    .option("--gamma-url <url>", "Gamma API URL", "https://gamma-api.polymarket.com")
    .option("--relayer-url <url>", "Polymarket relayer URL", "https://relayer-v2.polymarket.com")
    .action(async (options: RelayerInitOptions) => {
      try {
        const config = await loadConfig({ command: "auth", configPath: resolveCliConfigPath(program) });
        const secretsPath = resolveSecretsPath({ explicit: options.secrets, config });
        const values = await readWalletFile(secretsPath);
        if (!options.force && values.RELAYER_API_KEY?.trim()) {
          emit(program, {
            ok: true,
            command: "auth relayer-init",
            walletFile: secretsPath,
            created: false,
            address: values.RELAYER_API_KEY_ADDRESS ?? null
          });
          return;
        }
        const privateKey = parsePrivateKey(required(values, "PRIVATE_KEY"));
        const account = privateKeyToAccount(privateKey);
        const key = await createRelayerApiKeyWithGammaAuth({
          privateKey,
          gammaUrl: options.gammaUrl,
          relayerUrl: options.relayerUrl
        });
        await writeWalletFile(
          secretsPath,
          {
            ...values,
            PRIVATE_KEY: privateKey,
            RELAYER_API_KEY: key.apiKey,
            RELAYER_API_KEY_ADDRESS: key.address
          },
          { overwrite: true }
        );
        emit(program, {
          ok: true,
          command: "auth relayer-init",
          walletFile: secretsPath,
          address: account.address,
          keyAddress: key.address,
          created: true
        });
      } catch (error) {
        emitFailure(program, {
          ok: false,
          command: "auth relayer-init",
          error: "RELAYER_AUTH_INIT_FAILED",
          reason: error instanceof Error ? error.message : String(error)
        });
      }
    });
}

function required(values: Record<string, string>, key: string): string {
  const value = values[key]?.trim();
  if (!value) {
    throw new Error(`wallet file requires ${key}`);
  }
  return value;
}

function emit(program: Command, payload: Record<string, unknown>): void {
  if (program.optsWithGlobals().json) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function emitFailure(program: Command, payload: Record<string, unknown>): never {
  if (program.optsWithGlobals().json) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } else {
    process.stderr.write(`${payload.reason ?? payload.error ?? "auth failed"}\n`);
  }
  process.exit(EXIT_CODES.USAGE_OR_CONFIG);
}
