import { Command } from "commander";
import { listRows } from "../db-output.js";

export function registerPositions(program: Command): void {
  const positions = program.command("positions").description("Inspect local positions");
  positions
    .command("list")
    .description("List positions")
    .option("--db <path>", "SQLite DB path", "./.polycopy/polycopy.db")
    .option("--limit <count>", "row limit", "50")
    .action((options: { db: string; limit: string }) => {
      const rows = listRows(
        options.db,
        `SELECT token_id, shares_raw, expected_onchain_shares_raw, last_onchain_shares_raw, last_reconciled_at, updated_at
         FROM positions
         ORDER BY updated_at DESC
         LIMIT ${Number(options.limit)}`
      );
      process.stdout.write(`${JSON.stringify({ ok: true, positions: rows })}\n`);
    });
}
