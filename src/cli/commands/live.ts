import { Command } from "commander";
import { runCopytrade, type CopytradeCliOptions } from "./copytrade.js";

export function registerLive(program: Command): void {
  program
    .command("live")
    .description("Deprecated: use polycopy copytrade for unified live copy trading")
    .option("--leader <address>", "single configured leader subset for live")
    .option("--leaders <addresses>", "comma-separated configured leader subset for live")
    .option("--secrets <path>", "dotenv file with PRIVATE_KEY and CLOB credentials", ".env")
    .option("--duration-minutes <minutes>", "how long unified live runs (ingest + submit loop)", "1")
    .option("--poll-ms <ms>", "HTTP fallback poll interval and delay between submit-only cycles", "1000")
    .option("--lookback-blocks <blocks>", "initial safe-head lookback on startup", "500")
    .option("--confirmation-depth <blocks>", "blocks to wait before commit", "2")
    .option("--http-fallback", "use HTTP eth_getLogs catch-up instead of websocket detect")
    .option("--max-cycles <count>", "submit-only cycle cap when --submit-only is set", "1")
    .option("--submit-only", "skip ingestion and only run recovery/submit cycles against existing decisions")
    .action(
      async (options: {
        leader?: `0x${string}`;
        leaders?: string;
        secrets: string;
        durationMinutes: string;
        pollMs: string;
        lookbackBlocks: string;
        confirmationDepth: string;
        httpFallback?: boolean;
        maxCycles: string;
        submitOnly?: boolean;
      }) => {
        process.stderr.write("`polycopy live` is deprecated; use `polycopy copytrade` instead\n");
        const copytradeOptions: CopytradeCliOptions = {
          secrets: options.secrets,
          copyPct: "0.10",
          durationMinutes: options.durationMinutes,
          pollMs: options.pollMs,
          lookbackBlocks: options.lookbackBlocks,
          confirmationDepth: options.confirmationDepth,
          httpFallback: options.httpFallback,
          maxCycles: options.maxCycles,
          submitOnly: options.submitOnly,
          leaders: options.leaders,
          leader: options.leader
        };
        const leaders = options.leader ? [options.leader] : [];
        await runCopytrade(program, leaders, copytradeOptions, { forceConfigFile: true, legacyLive: true });
      }
    );
}
