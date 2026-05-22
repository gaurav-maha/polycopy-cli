import { Command } from "commander";
import { replayFixtures } from "../../replay/fixtures.js";

export function registerDemo(program: Command): void {
  program
    .command("demo")
    .description("Replay deterministic offline fixtures")
    .option("--fixture <name>", "fixture id or all", "all")
    .option("--db <path>", "SQLite DB path", "./.polycopy/polycopy.db")
    .option("--leader <address>", "single source wallet for fixture replay")
    .action(async (options: { fixture: string; db: string; leader?: string }) => {
      void options.leader;
      const summary = await replayFixtures({ dbPath: options.db, fixture: options.fixture });
      process.stdout.write(`${JSON.stringify({ ok: true, command: "demo", summary })}\n`);
    });
}
