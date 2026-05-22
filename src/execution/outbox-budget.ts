import type { SqliteDatabase } from "../db/client.js";
import type { HexAddress } from "../config/leaders.js";
import { dayUtcFromMs, reserveLeaderBudget } from "../risk/leader-budgets.js";

export function reserveOutboxLeaderBudget(
  db: SqliteDatabase,
  args: {
    sourceWallet: HexAddress;
    reservationId: string;
    approvedNotionalRaw: bigint;
    nowMs: number;
  }
): void {
  const dayUtc = dayUtcFromMs(args.nowMs);
  reserveLeaderBudget(db, {
    sourceWallet: args.sourceWallet,
    dayUtc,
    amountRaw: args.approvedNotionalRaw
  });
  db.prepare(
    `
      UPDATE risk_reservations
      SET source_wallet = ?
      WHERE id = ?
    `
  ).run(args.sourceWallet, args.reservationId);
}
