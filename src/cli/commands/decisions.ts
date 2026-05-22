import { Command } from "commander";
import { listRows } from "../db-output.js";

export function registerDecisions(program: Command): void {
  const decisions = program.command("decisions").description("Inspect copy decisions");
  decisions
    .command("list")
    .description("List copy decisions")
    .option("--db <path>", "SQLite DB path", "./.polycopy/polycopy.db")
    .option("--limit <count>", "row limit", "50")
    .action((options: { db: string; limit: string }) => {
      const rows = listRows(
        options.db,
        `SELECT id, source_wallet, side, token_id, status, skip_reason, intended_copy_notional_raw, approved_copy_notional_raw, created_at
         FROM copy_decisions
         ORDER BY created_at DESC
         LIMIT ${Number(options.limit)}`
      );
      process.stdout.write(`${JSON.stringify({ ok: true, decisions: rows })}\n`);
    });
}
