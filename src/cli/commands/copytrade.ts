import { Command } from "commander";
import { dirname } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { PolymarketClobAdapter } from "../../adapters/polymarket-clob.js";
import type { Hex } from "../../adapters/types.js";
import { assertLiveWalletModeSupported } from "../../account/invariants.js";
import { buildConfig } from "../../config/build.js";
import { buildCopytradeConfig } from "../../config/copytrade-config.js";
import {
  assertLeadersForCommand,
  parseLeaderArguments,
  parseLeadersOption,
  resolveActiveLeaders,
  type HexAddress
} from "../../config/leaders.js";
import { loadLiveSecrets } from "../../config/live-secrets.js";
import { resolveRpcUrls } from "../../config/rpc-persist.js";
import { resolveSecretsPath } from "../../config/secrets-path.js";
import { runLiveDataDryRun } from "../../dry-run/live-data.js";
import { EXIT_CODES } from "../../errors/exit-codes.js";
import {
  ingestionRiskFromConfig,
  runUnifiedLiveLoop,
  summarizeUnifiedLive
} from "../../execution/unified-live-runner.js";
import { createHttpRpcAdapter } from "../../ingestion/catch-up.js";
import { resolveWsUrl } from "../../ingestion/rpc-url.js";
import { CONSERVATIVE_RISK } from "../../config/dry-run-presets.js";
import { assertLiveStartupReady } from "../../live/startup-checks.js";
import { resolveCliConfigPath } from "../config-path.js";
import {
  ciPromptBypass,
  confirmLiveSubmission,
  emitCliExit,
  isKillSwitchActive,
  prepareLiveDatabase
} from "../live-bootstrap.js";

export type CopytradeCliOptions = {
  config?: string;
  dryRun?: boolean;
  secrets?: string;
  copyPct?: string;
  budget?: string;
  maxTradeSize?: string;
  enableSell?: boolean;
  db?: string;
  log?: string;
  durationMinutes: string;
  pollMs: string;
  lookbackBlocks: string;
  confirmationDepth: string;
  httpFallback?: boolean;
  maxIterations?: string;
  submitOnly?: boolean;
  maxCycles: string;
  leaders?: string;
  leader?: HexAddress;
};

export type CopytradeRunContext = {
  forceConfigFile?: boolean;
  legacyLive?: boolean;
};

function definedRisk(configRisk: Awaited<ReturnType<typeof buildCopytradeConfig>>["risk"]) {
  return Object.fromEntries(Object.entries(configRisk).filter(([, value]) => value !== undefined));
}

function parseIntegerOption(
  program: Command,
  option: string,
  raw: string,
  args: { min: number; scale?: number }
): number {
  if (!/^\d+$/.test(raw)) {
    invalidIntegerOption(program, option, args.min);
  }
  const parsed = Number(raw);
  const scale = args.scale ?? 1;
  const scaled = parsed * scale;
  if (!Number.isSafeInteger(parsed) || parsed < args.min || !Number.isSafeInteger(scaled)) {
    invalidIntegerOption(program, option, args.min);
  }
  return scaled;
}

function parseBigIntOption(program: Command, option: string, raw: string, args: { min: bigint }): bigint {
  if (!/^\d+$/.test(raw)) {
    invalidIntegerOption(program, option, args.min.toString());
  }
  const parsed = BigInt(raw);
  if (parsed < args.min) {
    invalidIntegerOption(program, option, args.min.toString());
  }
  return parsed;
}

function invalidIntegerOption(program: Command, option: string, min: number | string): never {
  emitCliExit(
    program,
    {
      error: "COPYTRADE_INVALID_OPTION",
      option,
      reason: `--${option} must be an integer greater than or equal to ${min}`
    },
    EXIT_CODES.USAGE_OR_CONFIG
  );
}

function useConfigFileSource(program: Command, options: CopytradeCliOptions, context?: CopytradeRunContext): boolean {
  if (context?.forceConfigFile) {
    return true;
  }
  const globalOptions = program.optsWithGlobals() as { config?: string };
  return Boolean(options.config ?? globalOptions.config);
}

function resolveActiveCopytradeLeaders(
  config: Awaited<ReturnType<typeof buildCopytradeConfig>>,
  leaders: string[],
  options: CopytradeCliOptions,
  useConfigFile: boolean
): HexAddress[] {
  if (useConfigFile) {
    const cliLeaders =
      options.leaders !== undefined
        ? parseLeadersOption(options.leaders)
        : leaders.length > 0
          ? parseLeadersOption(leaders.join(","))
          : undefined;
    const activeLeaders = resolveActiveLeaders(config, {
      leader: options.leader,
      leaders: cliLeaders
    });
    assertLeadersForCommand(activeLeaders, {
      command: "copytrade",
      configured: config.sourceWallets as HexAddress[],
      requireConfigured: !options.leader && !options.leaders && leaders.length === 0
    });
    return activeLeaders;
  }
  return parseLeaderArguments(leaders, options.leaders);
}

export async function runCopytrade(
  program: Command,
  leaders: string[],
  options: CopytradeCliOptions,
  context?: CopytradeRunContext
): Promise<void> {
  try {
    const useConfigFile = useConfigFileSource(program, options, context);
    const configPath = useConfigFile ? resolveCliConfigPath(program, options.config) : undefined;
    const enableSellOverride = options.enableSell === true ? true : undefined;
    const defaultEnableSell = options.enableSell === true;
    const durationMs = parseIntegerOption(program, "duration-minutes", options.durationMinutes, {
      min: 0,
      scale: 60_000
    });
    const pollMs = parseIntegerOption(program, "poll-ms", options.pollMs, { min: 0 });
    const lookbackBlocks = parseBigIntOption(program, "lookback-blocks", options.lookbackBlocks, { min: 0n });
    const confirmationDepth = BigInt(
      parseIntegerOption(program, "confirmation-depth", options.confirmationDepth, { min: 2 })
    );
    const maxIterations =
      options.maxIterations === undefined
        ? undefined
        : parseIntegerOption(program, "max-iterations", options.maxIterations, { min: 0 });
    const maxCycles = parseIntegerOption(program, "max-cycles", options.maxCycles, { min: 1 });
    const copyPct = options.copyPct ?? (useConfigFile ? undefined : "0.10");

    if (options.dryRun) {
      const rpcUrls = useConfigFile ? undefined : await resolveRpcUrls();
      const config = useConfigFile
        ? await buildConfig({
            command: "copytrade",
            configPath,
            copyPct,
            budgetUsd: options.budget,
            maxTradeSizeUsd: options.maxTradeSize,
            enableSell: enableSellOverride,
            dbPath: options.db,
            logDir: options.log ? dirname(options.log) : undefined
          })
        : await buildCopytradeConfig({
            leaders: parseLeaderArguments(leaders, options.leaders),
            rpcUrls: rpcUrls!,
            copyPct,
            budgetUsd: options.budget,
            maxTradeSizeUsd: options.maxTradeSize,
            enableSell: defaultEnableSell,
            dbPath: options.db,
            logDir: options.log ? dirname(options.log) : undefined
          });
      const activeLeaders = resolveActiveCopytradeLeaders(config, leaders, options, useConfigFile);
      const primaryRpc = useConfigFile
        ? (config.rpcProviders.find((provider) => provider.name === "primary")?.url ?? config.rpcProviders[0]?.url)
        : rpcUrls![0];
      if (!primaryRpc) {
        emitCliExit(
          program,
          { error: "COPYTRADE_RPC_CONFIG", reason: "copytrade requires rpcProviders primary url" },
          EXIT_CODES.USAGE_OR_CONFIG
        );
      }
      const wsUrl = process.env.POLYGON_RPC_WS ?? resolveWsUrl({ rpcUrl: primaryRpc });
      const summary = await runLiveDataDryRun({
        rpcUrl: primaryRpc,
        wsUrl,
        leaders: activeLeaders,
        config,
        dbPath: options.db ?? config.runtime.dbPath,
        logPath: options.log ?? `${config.runtime.logDir}/copytrade.jsonl`,
        durationMs,
        pollMs,
        lookbackBlocks,
        confirmationDepth,
        aggregationWindowBlocks: config.runtime.aggregationWindowBlocks,
        reorgLookbackBlocks: config.runtime.reorgLookbackBlocks,
        confirmedLogMaxDelayMs: config.runtime.confirmedLogMaxDelayMs,
        polygonBlockTimeMs: config.runtime.polygonBlockTimeMs,
        risk: { ...CONSERVATIVE_RISK, ...definedRisk(config.risk) },
        enableSell: useConfigFile ? config.copy.enableSell : defaultEnableSell,
        maxIterations,
        useWebSocket: !options.httpFallback
      });
      process.stdout.write(
        `${JSON.stringify({ ok: true, command: "copytrade", mode: "dry-run", leaders: activeLeaders, summary })}\n`
      );
      return;
    }

    const rpcUrls = useConfigFile ? undefined : await resolveRpcUrls();
    const config = useConfigFile
      ? await buildConfig({
          command: "copytrade",
          configPath,
          copyPct,
          budgetUsd: options.budget,
          maxTradeSizeUsd: options.maxTradeSize,
          enableSell: enableSellOverride,
          dbPath: options.db,
          logDir: options.log ? dirname(options.log) : undefined
        })
      : await buildCopytradeConfig({
          leaders: parseLeaderArguments(leaders, options.leaders),
          rpcUrls: rpcUrls!,
          copyPct,
          budgetUsd: options.budget,
          maxTradeSizeUsd: options.maxTradeSize,
          enableSell: defaultEnableSell,
          live: true,
          dbPath: options.db,
          logDir: options.log ? dirname(options.log) : undefined
        });

    if (useConfigFile && !config.live.enabled) {
      emitCliExit(program, { ok: false, error: "LIVE_NOT_ENABLED" }, EXIT_CODES.USAGE_OR_CONFIG, {
        includeOkFalse: true
      });
    }

    let activeLeaders: HexAddress[];
    try {
      activeLeaders = resolveActiveCopytradeLeaders(config, leaders, options, useConfigFile);
    } catch (error) {
      emitCliExit(
        program,
        { error: "COPYTRADE_LEADER_CONFIG", reason: error instanceof Error ? error.message : String(error) },
        EXIT_CODES.USAGE_OR_CONFIG
      );
    }

    if (activeLeaders.length === 0) {
      emitCliExit(program, { error: "COPYTRADE_LEADERS_REQUIRED" }, EXIT_CODES.USAGE_OR_CONFIG);
    }

    try {
      assertLiveWalletModeSupported(config.account);
    } catch (error) {
      emitCliExit(
        program,
        { error: "UNSUPPORTED_WALLET_MODE", reason: error instanceof Error ? error.message : String(error) },
        EXIT_CODES.NOT_IMPLEMENTED
      );
    }

    if (await isKillSwitchActive(config.runtime.killSwitchPath)) {
      emitCliExit(
        program,
        { error: "KILL_SWITCH_ACTIVE", path: config.runtime.killSwitchPath },
        EXIT_CODES.KILL_SWITCH_ACTIVE
      );
    }

    if (useConfigFile && (!config.account.ownerSignerAddress || !config.account.funderAddress)) {
      emitCliExit(
        program,
        {
          error: "COPYTRADE_ACCOUNT_CONFIG",
          reason: "copytrade requires ownerSignerAddress and funderAddress"
        },
        EXIT_CODES.USAGE_OR_CONFIG
      );
    }

    const ciMode = ciPromptBypass(config);
    const primaryRpc = useConfigFile
      ? (config.rpcProviders.find((provider) => provider.name === "primary")?.url ?? config.rpcProviders[0]?.url)
      : rpcUrls![0];
    const fallbackRpc = useConfigFile
      ? config.rpcProviders.find((provider) => provider.name === "fallback")?.url
      : rpcUrls![1];

    if (!primaryRpc) {
      emitCliExit(
        program,
        { error: "COPYTRADE_RPC_CONFIG", reason: "copytrade requires rpcProviders primary url" },
        EXIT_CODES.USAGE_OR_CONFIG
      );
    }
    if (!ciMode && !fallbackRpc) {
      emitCliExit(
        program,
        { error: "COPYTRADE_RPC_CONFIG", reason: "copytrade requires rpcProviders fallback url" },
        EXIT_CODES.USAGE_OR_CONFIG
      );
    }

    const secretsPath = resolveSecretsPath({ explicit: options.secrets, config });
    const liveSecrets = await loadLiveSecrets(secretsPath);
    const signerAccount = privateKeyToAccount(liveSecrets.privateKey);

    let owner: Hex;
    let funder: Hex;
    if (useConfigFile) {
      if (signerAccount.address.toLowerCase() !== config.account.ownerSignerAddress!.toLowerCase()) {
        throw new Error("PRIVATE_KEY does not match configured ownerSignerAddress");
      }
      owner = config.account.ownerSignerAddress as Hex;
      funder = config.account.funderAddress as Hex;
    } else {
      owner = signerAccount.address as Hex;
      funder = owner;
    }

    try {
      await confirmLiveSubmission({ bypass: ciMode });
    } catch (error) {
      if (error instanceof Error && error.message === "LIVE_PROMPT_ABORTED") {
        emitCliExit(program, { error: "LIVE_PROMPT_ABORTED" }, EXIT_CODES.USAGE_OR_CONFIG);
      }
      throw error;
    }

    const submitOnly = Boolean(options.submitOnly) || ciMode;
    const liveDurationMs = submitOnly ? 0 : durationMs;
    const livePollMs = pollMs;

    const clob = new PolymarketClobAdapter({
      privateKey: liveSecrets.privateKey,
      rpcUrl: primaryRpc,
      creds: liveSecrets.clobCreds,
      signatureType: config.account.signatureType,
      funder
    });
    const rpc = createHttpRpcAdapter(primaryRpc);
    const fallbackRpcAdapter = fallbackRpc ? createHttpRpcAdapter(fallbackRpc) : rpc;
    const receiptRpc = fallbackRpc ?? primaryRpc;
    const dbPath = options.db ?? config.runtime.dbPath;
    const db = await prepareLiveDatabase({
      dbPath,
      logDir: config.runtime.logDir,
      lockPath: config.runtime.lockPath
    });

    try {
      if (!ciMode && configPath) {
        await assertLiveStartupReady({
          config,
          configPath,
          envPath: secretsPath,
          db,
          primaryRpc: rpc,
          fallbackRpc: fallbackRpcAdapter
        });
      }
      const summary = await runUnifiedLiveLoop({
        config,
        db,
        leaders: activeLeaders,
        rpcUrl: primaryRpc,
        wsUrl: resolveWsUrl({ rpcUrl: primaryRpc, wsUrl: process.env.POLYGON_RPC_WS }),
        receiptVerificationRpcUrl: receiptRpc,
        logPath: options.log ?? `${config.runtime.logDir}/copytrade.jsonl`,
        durationMs: liveDurationMs,
        pollMs: livePollMs,
        lookbackBlocks,
        useWebSocket: !options.httpFallback,
        risk: ingestionRiskFromConfig(config),
        enableSell: useConfigFile ? config.copy.enableSell : defaultEnableSell,
        clob,
        signer: clob,
        rpc,
        owner,
        funder,
        signatureType: config.account.signatureType,
        encryptionKey: liveSecrets.payloadEncryptionKey,
        lockPath: config.runtime.lockPath,
        killSwitchActive: () => isKillSwitchActive(config.runtime.killSwitchPath),
        skipIngestion: submitOnly,
        maxLiveCycles: maxCycles
      });
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          command: context?.legacyLive ? "live" : "copytrade",
          mode: "live",
          wallet: owner,
          leaders: activeLeaders,
          summary: summarizeUnifiedLive(summary)
        })}\n`
      );
    } finally {
      db.close();
    }
  } catch (error) {
    emitCliExit(
      program,
      { error: "COPYTRADE_FAILED", reason: error instanceof Error ? error.message : String(error) },
      EXIT_CODES.USAGE_OR_CONFIG
    );
  }
}

export function registerCopytrade(program: Command): void {
  program
    .command("copytrade")
    .description("Copy trade one or more leader wallets (live by default)")
    .argument("[leaders...]", "leader wallet address(es) to copy")
    .option("--config <path>", "config file path")
    .option("--leaders <addresses>", "comma-separated leader addresses")
    .option("--dry-run", "watch leaders and compute decisions without submitting orders")
    .option("--secrets <path>", "wallet env file with PRIVATE_KEY and CLOB credentials")
    .option("--copy-pct <decimal>", "copy percentage")
    .option("--budget <usd>", "total pUSD budget allocated to copy trading")
    .option("--max-trade-size <usd>", "maximum pUSD size for a single copied trade")
    .option("--enable-sell", "include leader sell signals")
    .option("--db <path>", "SQLite DB path")
    .option("--log <path>", "JSONL log path")
    .option("--duration-minutes <minutes>", "how long to run", "1")
    .option("--poll-ms <ms>", "HTTP fallback poll interval and delay between submit-only cycles", "10000")
    .option("--lookback-blocks <blocks>", "initial safe-head lookback", "500")
    .option("--confirmation-depth <blocks>", "blocks to wait before commit", "2")
    .option("--http-fallback", "use HTTP eth_getLogs catch-up instead of websocket detect")
    .option("--max-iterations <count>", "development iteration cap")
    .option("--submit-only", "skip ingestion and only run recovery/submit cycles against existing decisions")
    .option("--max-cycles <count>", "submit-only cycle cap when --submit-only is set", "1")
    .action(async (leaders: string[], options: CopytradeCliOptions) => {
      await runCopytrade(program, leaders, options);
    });
}
