import { Command } from "commander";
import { applyEoaWallet, applyPoly1271Wallet, applyPolyProxyWallet } from "../../config/account-set.js";
import { loadConfig } from "../../config/load.js";
import { writeConfigFile } from "../../config/persist.js";
import type { Config, WalletMode } from "../../config/schema.js";
import { walletModeSchema } from "../../config/schema.js";
import { normalizeCopyPct } from "../../config/user-input.js";
import { redact } from "../../logging/jsonl.js";
import { resolveCliConfigPath } from "../config-path.js";

type ConfigSetOptions = {
  leader?: string;
  copyPct?: string;
  enableSell?: string;
  liveEnabled?: string;
  rpcPrimary?: string;
  rpcFallback?: string;
  secrets?: string;
  walletMode?: string;
  owner?: string;
  proxy?: string;
  depositWallet?: string;
};

export function registerConfig(program: Command): void {
  const config = program.command("config").description("Manage persistent config");
  config
    .command("path")
    .description("Print config path")
    .action(() => {
      process.stdout.write(`${JSON.stringify({ ok: true, path: resolveCliConfigPath(program) })}\n`);
    });
  config
    .command("get")
    .description("Print redacted config")
    .action(async () => {
      const path = resolveCliConfigPath(program);
      const loaded = await loadConfig({ command: "config", configPath: path });
      process.stdout.write(`${JSON.stringify({ ok: true, config: redact(loaded) })}\n`);
    });
  config
    .command("set")
    .description("Set config values")
    .option("--leader <address>", "replace configured source wallets with one address")
    .option("--copy-pct <decimal>", "set copy percentage")
    .option("--enable-sell <boolean>", "set copy.enableSell")
    .option("--live-enabled <boolean>", "set live.enabled")
    .option("--rpc-primary <url>", "set primary Polygon RPC URL")
    .option("--rpc-fallback <url>", "set fallback Polygon RPC URL")
    .option("--secrets <path>", "set default local wallet/secrets file path")
    .option("--wallet-mode <mode>", "set wallet mode: EOA, POLY_PROXY, or POLY_1271")
    .option("--owner <address>", "set owner signer address for the configured wallet mode")
    .option("--proxy <address>", "set POLY_PROXY wallet address used as maker/funder")
    .option("--deposit-wallet <address>", "set POLY_1271 deposit wallet address used as maker/signer/funder")
    .action(async (options: ConfigSetOptions) => {
      const path = resolveCliConfigPath(program);
      const loaded = await loadConfig({ command: "config", configPath: path });
      if (options.leader) loaded.sourceWallets = [options.leader as `0x${string}`];
      if (options.copyPct) loaded.risk.copyPct = normalizeCopyPct(options.copyPct);
      if (options.enableSell !== undefined) loaded.copy.enableSell = options.enableSell === "true";
      if (options.liveEnabled !== undefined) loaded.live.enabled = options.liveEnabled === "true";
      if (options.secrets) loaded.runtime.secretsPath = options.secrets;
      applyAccountConfigSetOptions(loaded, options);
      if (options.rpcPrimary) {
        loaded.rpcProviders = loaded.rpcProviders.filter((provider) => provider.name !== "primary");
        loaded.rpcProviders.unshift({ name: "primary", url: options.rpcPrimary, maxLagMs: 30_000, maxLagBlocks: 1 });
      }
      if (options.rpcFallback) {
        loaded.rpcProviders = loaded.rpcProviders.filter((provider) => provider.name !== "fallback");
        loaded.rpcProviders.push({ name: "fallback", url: options.rpcFallback, maxLagMs: 30_000, maxLagBlocks: 1 });
      }
      await writeConfigFile(path, loaded);
      process.stdout.write(`${JSON.stringify({ ok: true, path, account: loaded.account })}\n`);
    });
  config
    .command("validate")
    .description("Validate config")
    .action(async () => {
      const path = resolveCliConfigPath(program);
      await loadConfig({ command: "config", configPath: path });
      process.stdout.write(`${JSON.stringify({ ok: true, path })}\n`);
    });
}

function applyAccountConfigSetOptions(config: Config, options: ConfigSetOptions): void {
  const walletMode = resolveRequestedWalletMode(config.account.walletMode, options);
  if (!walletMode) return;

  if (walletMode === "EOA") {
    const wallet = options.owner ?? config.account.ownerSignerAddress;
    if (!wallet) {
      throw new Error("config set --wallet-mode EOA requires --owner <address>");
    }
    config.account = applyEoaWallet(config.account, wallet);
    return;
  }

  if (walletMode === "POLY_PROXY") {
    const owner = options.owner ?? config.account.ownerSignerAddress;
    const proxy = options.proxy ?? config.account.orderMakerAddress ?? config.account.funderAddress;
    if (!owner || !proxy) {
      throw new Error("config set --wallet-mode POLY_PROXY requires --owner <address> and --proxy <address>");
    }
    config.account = applyPolyProxyWallet(config.account, { owner, proxy });
    return;
  }

  const owner = options.owner ?? config.account.ownerSignerAddress;
  const depositWallet = options.depositWallet ?? config.account.funderAddress;
  if (!owner || !depositWallet) {
    throw new Error("config set --wallet-mode POLY_1271 requires --owner <address> and --deposit-wallet <address>");
  }
  config.account = applyPoly1271Wallet(config.account, { owner, contract: depositWallet });
}

function resolveRequestedWalletMode(current: WalletMode, options: ConfigSetOptions): WalletMode | undefined {
  if (options.walletMode) {
    return parseWalletMode(options.walletMode);
  }
  if (options.depositWallet) return "POLY_1271";
  if (options.proxy) return "POLY_PROXY";
  if (options.owner) return current;
  return undefined;
}

function parseWalletMode(input: string): WalletMode {
  const normalized = input.trim().toUpperCase().replaceAll("-", "_");
  const compact = normalized.replaceAll("_", "");
  if (compact === "POLY1271") return "POLY_1271";
  if (compact === "POLYPROXY") return "POLY_PROXY";
  return walletModeSchema.parse(normalized);
}
