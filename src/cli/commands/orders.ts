import { Command } from "commander";
import { listRows } from "../db-output.js";

export function registerOrders(program: Command): void {
  const orders = program.command("orders").description("Inspect order submissions");
  orders
    .command("list")
    .description("List order submissions")
    .option("--db <path>", "SQLite DB path", "./.polycopy/polycopy.db")
    .option("--limit <count>", "row limit", "50")
    .action((options: { db: string; limit: string }) => {
      const rows = listRows(
        options.db,
        `SELECT id, copy_decision_id, signed_order_hash, current_state, order_type, intended_notional_raw, intended_size_raw, created_at
         FROM order_submissions
         ORDER BY created_at DESC
         LIMIT ${Number(options.limit)}`
      );
      process.stdout.write(`${JSON.stringify({ ok: true, orders: rows })}\n`);
    });
}
