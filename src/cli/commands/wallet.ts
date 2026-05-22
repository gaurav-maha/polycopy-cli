import { Command } from "commander";
import { dirname, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { applyOwnerSignerWallet } from "../../config/account-set.js";
import { loadConfig } from "../../config/load.js";
import { writeConfigFile } from "../../config/persist.js";
import { parsePrivateKey, readWalletFile, writeWalletFile } from "../../config/wallet-file.js";
import { resolveCliConfigPath } from "../config-path.js";

type WalletNewOptions = {
  walletFile?: string;
  force?: boolean;
};

type WalletImportOptions = {
  walletFile?: string;
  privateKeyFile?: string;
  force?: boolean;
  noInput?: boolean;
};

export function registerWallet(program: Command): void {
  const wallet = program.command("wallet").description("Manage the local EOA wallet file");

  wallet
    .command("new")
    .description("Create a new EOA wallet and set it as the default")
    .option("--wallet-file <path>", "wallet env file to create")
    .option("--force", "overwrite an existing wallet file")
    .action(async (options: WalletNewOptions) => {
      const walletFile = defaultWalletFile(program, options.walletFile);
      const privateKey = generatePrivateKey();
      await persistWallet(program, walletFile, privateKey, { overwrite: options.force === true });
      emit(program, {
        ok: true,
        command: "wallet new",
        walletFile,
        address: privateKeyToAccount(privateKey).address
      });
    });

  wallet
    .command("import")
    .description("Import an existing EOA private key into the default wallet file")
    .option("--wallet-file <path>", "wallet env file to create")
    .option("--private-key-file <path>", "file containing the private key")
    .option("--force", "overwrite an existing wallet file")
    .option("--no-input", "do not prompt for private key")
    .action(async (options: WalletImportOptions) => {
      const walletFile = defaultWalletFile(program, options.walletFile);
      const privateKey = await readImportPrivateKey(options);
      await persistWallet(program, walletFile, privateKey, { overwrite: options.force === true });
      emit(program, {
        ok: true,
        command: "wallet import",
        walletFile,
        address: privateKeyToAccount(privateKey).address
      });
    });

  wallet
    .command("use")
    .description("Use an existing wallet env file")
    .argument("<wallet-file>", "wallet env file with PRIVATE_KEY")
    .action(async (walletFile: string) => {
      const values = await readWalletFile(walletFile);
      const privateKey = parsePrivateKey(required(values, "PRIVATE_KEY"));
      await persistAccountConfig(program, walletFile, privateKey);
      emit(program, {
        ok: true,
        command: "wallet use",
        walletFile,
        address: privateKeyToAccount(privateKey).address
      });
    });

  wallet
    .command("show")
    .description("Show the configured wallet address")
    .action(async () => {
      const config = await loadConfig({ command: "wallet", configPath: resolveCliConfigPath(program) });
      const walletFile = config.runtime.secretsPath;
      emit(program, {
        ok: true,
        command: "wallet show",
        walletFile,
        address: config.account.ownerSignerAddress ?? null
      });
    });
}

function defaultWalletFile(program: Command, explicit?: string): string {
  if (explicit) return explicit;
  return resolve(dirname(resolveCliConfigPath(program)), "wallet.env");
}

async function persistWallet(
  program: Command,
  walletFile: string,
  privateKey: `0x${string}`,
  options: { overwrite: boolean }
) {
  await writeWalletFile(walletFile, { PRIVATE_KEY: privateKey }, { overwrite: options.overwrite });
  await persistAccountConfig(program, walletFile, privateKey);
}

async function persistAccountConfig(program: Command, walletFile: string, privateKey: `0x${string}`) {
  const configPath = resolveCliConfigPath(program);
  const config = await loadConfig({ command: "wallet", configPath });
  config.runtime.secretsPath = walletFile;
  config.account = applyOwnerSignerWallet(config.account, privateKeyToAccount(privateKey).address);
  await writeConfigFile(configPath, config);
}

async function readImportPrivateKey(options: WalletImportOptions): Promise<`0x${string}`> {
  if (options.privateKeyFile) {
    return parsePrivateKey((await readFile(options.privateKeyFile, "utf8")).trim());
  }
  if (options.noInput || !input.isTTY) {
    throw new Error("wallet import requires --private-key-file when prompts are unavailable");
  }
  const rl = createInterface({ input, output });
  try {
    return parsePrivateKey((await rl.question("Private key: ")).trim());
  } finally {
    rl.close();
  }
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
