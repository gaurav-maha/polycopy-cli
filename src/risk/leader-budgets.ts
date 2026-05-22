import { getAddress } from "viem";
import type { SqliteDatabase } from "../db/client.js";
import type { Config } from "../config/schema.js";
import { leaderMaxDailySpendRaw } from "../config/leaders.js";
import { stableId } from "../ingestion/pending-fills.js";
import { loadActivePUsdReservationsRaw } from "./reservations.js";

export type HexAddress = `0x${string}`;

export type LeaderDailyBudget = {
  realizedSpendPusdRaw: bigint;
  reservedSpendPusdRaw: bigint;
  tradeCount: number;
};

export type DecisionBatchState = {
  dayUtc: string;
  globalReservedRaw: bigint;
  globalDailySpentRaw: bigint;
  globalDailyReservedRaw: bigint;
  globalTradeCount: number;
  leaderDaily: Map<string, LeaderDailyBudget>;
  tokenClaims: Set<string>;
};

export type ContentionKind = "GLOBAL" | "LEADER" | "TOKEN" | "QUEUE";

export function dayUtcFromMs(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export function tokenSideKey(tokenId: string, side: "BUY" | "SELL"): string {
  return `${tokenId}|${side}`;
}

export function createDecisionBatchState(args: {
  nowMs: number;
  globalReservedRaw?: bigint;
  globalDailySpentRaw?: bigint;
  globalDailyReservedRaw?: bigint;
  globalTradeCount?: number;
  leaderDaily?: Map<string, LeaderDailyBudget>;
}): DecisionBatchState {
  return {
    dayUtc: dayUtcFromMs(args.nowMs),
    globalReservedRaw: args.globalReservedRaw ?? 0n,
    globalDailySpentRaw: args.globalDailySpentRaw ?? 0n,
    globalDailyReservedRaw: args.globalDailyReservedRaw ?? 0n,
    globalTradeCount: args.globalTradeCount ?? 0,
    leaderDaily: args.leaderDaily ?? new Map(),
    tokenClaims: new Set()
  };
}

function leaderKey(wallet: HexAddress): string {
  return getAddress(wallet).toLowerCase();
}

function readLeaderBudgetRow(
  db: SqliteDatabase,
  wallet: HexAddress,
  dayUtc: string
): LeaderDailyBudget {
  const row = db
    .prepare(
      `
        SELECT realized_spend_pusd_raw, reserved_spend_pusd_raw, trade_count
        FROM leader_budgets
        WHERE source_wallet = ? AND day_utc = ?
      `
    )
    .get(getAddress(wallet), dayUtc) as
    | { realized_spend_pusd_raw: string; reserved_spend_pusd_raw: string; trade_count: number }
    | undefined;
  if (!row) {
    return { realizedSpendPusdRaw: 0n, reservedSpendPusdRaw: 0n, tradeCount: 0 };
  }
  return {
    realizedSpendPusdRaw: BigInt(row.realized_spend_pusd_raw),
    reservedSpendPusdRaw: BigInt(row.reserved_spend_pusd_raw),
    tradeCount: row.trade_count
  };
}

export function loadDecisionBatchState(db: SqliteDatabase, args: { nowMs: number; leaders: HexAddress[] }): DecisionBatchState {
  const dayUtc = dayUtcFromMs(args.nowMs);
  const leaderDaily = new Map<string, LeaderDailyBudget>();
  for (const leader of args.leaders) {
    leaderDaily.set(leaderKey(leader), readLeaderBudgetRow(db, leader, dayUtc));
  }

  const global = db
    .prepare(
      `
        SELECT
          COALESCE(SUM(CAST(realized_spend_pusd_raw AS INTEGER)), 0) AS realized,
          COALESCE(SUM(CAST(reserved_spend_pusd_raw AS INTEGER)), 0) AS reserved,
          COALESCE(SUM(trade_count), 0) AS trade_count
        FROM leader_budgets
        WHERE day_utc = ?
      `
    )
    .get(dayUtc) as { realized: number; reserved: number; trade_count: number };

  return createDecisionBatchState({
    nowMs: args.nowMs,
    globalReservedRaw: loadActivePUsdReservationsRaw(db),
    globalDailySpentRaw: BigInt(global.realized),
    globalDailyReservedRaw: BigInt(global.reserved),
    globalTradeCount: global.trade_count,
    leaderDaily
  });
}

export function getLeaderDailyBudget(state: DecisionBatchState, wallet: HexAddress): LeaderDailyBudget {
  return state.leaderDaily.get(leaderKey(wallet)) ?? { realizedSpendPusdRaw: 0n, reservedSpendPusdRaw: 0n, tradeCount: 0 };
}

export function leaderDailyRemainingRaw(
  config: Config,
  state: DecisionBatchState,
  wallet: HexAddress,
  globalMaxDailySpendRaw: bigint
): bigint {
  const leaderBudget = getLeaderDailyBudget(state, wallet);
  const leaderCapRaw = leaderMaxDailySpendRaw(config, wallet);
  const leaderLimit = leaderCapRaw ? BigInt(leaderCapRaw) : globalMaxDailySpendRaw;
  const leaderUsed = leaderBudget.realizedSpendPusdRaw + leaderBudget.reservedSpendPusdRaw + state.globalReservedRaw;
  return leaderLimit > leaderUsed ? leaderLimit - leaderUsed : 0n;
}

export function globalDailyRemainingRaw(
  config: { maxDailySpendPusdRaw: string; maxTradesPerDay: number },
  state: DecisionBatchState
): bigint {
  const dailyCap = BigInt(config.maxDailySpendPusdRaw);
  const used = state.globalDailySpentRaw + state.globalDailyReservedRaw + state.globalReservedRaw;
  if (used >= dailyCap) return 0n;
  if (state.globalTradeCount >= config.maxTradesPerDay) return 0n;
  return dailyCap - used;
}

export function globalFreeBudgetRemainingRaw(
  config: { freeBudgetPusdRaw: string },
  state: DecisionBatchState
): bigint {
  const freeBudget = BigInt(config.freeBudgetPusdRaw);
  const used = state.globalReservedRaw;
  return freeBudget > used ? freeBudget - used : 0n;
}

export function tryClaimToken(state: DecisionBatchState, tokenId: string, side: "BUY" | "SELL"): boolean {
  const key = tokenSideKey(tokenId, side);
  if (state.tokenClaims.has(key)) return false;
  state.tokenClaims.add(key);
  return true;
}

export function applyBatchApproval(
  state: DecisionBatchState,
  wallet: HexAddress,
  approvedNotionalRaw: bigint
): void {
  state.globalReservedRaw += approvedNotionalRaw;
  state.globalTradeCount += 1;
  const key = leaderKey(wallet);
  const current = getLeaderDailyBudget(state, wallet);
  state.leaderDaily.set(key, {
    realizedSpendPusdRaw: current.realizedSpendPusdRaw,
    reservedSpendPusdRaw: current.reservedSpendPusdRaw + approvedNotionalRaw,
    tradeCount: current.tradeCount + 1
  });
}

export function reserveLeaderBudget(
  db: SqliteDatabase,
  args: { sourceWallet: HexAddress; dayUtc: string; amountRaw: bigint }
): void {
  const wallet = getAddress(args.sourceWallet);
  const id = stableId("lb", `${wallet}|${args.dayUtc}`);
  db.prepare(
    `
      INSERT INTO leader_budgets (
        id, source_wallet, day_utc, realized_spend_pusd_raw, reserved_spend_pusd_raw, trade_count
      ) VALUES (
        @id, @sourceWallet, @dayUtc, '0', @amountRaw, 1
      )
      ON CONFLICT(source_wallet, day_utc) DO UPDATE SET
        reserved_spend_pusd_raw = CAST(reserved_spend_pusd_raw AS INTEGER) + CAST(@amountRaw AS INTEGER),
        trade_count = trade_count + 1,
        updated_at = datetime('now')
    `
  ).run({
    id,
    sourceWallet: wallet,
    dayUtc: args.dayUtc,
    amountRaw: args.amountRaw.toString()
  });
}

export function releaseLeaderBudgetReservation(
  db: SqliteDatabase,
  args: { sourceWallet: HexAddress; dayUtc: string; amountRaw: bigint; moveToRealized: boolean }
): void {
  const wallet = getAddress(args.sourceWallet);
  if (args.moveToRealized) {
    db.prepare(
      `
        UPDATE leader_budgets
        SET
          reserved_spend_pusd_raw = CAST(reserved_spend_pusd_raw AS INTEGER) - CAST(? AS INTEGER),
          realized_spend_pusd_raw = CAST(realized_spend_pusd_raw AS INTEGER) + CAST(? AS INTEGER),
          updated_at = datetime('now')
        WHERE source_wallet = ? AND day_utc = ?
      `
    ).run(args.amountRaw.toString(), args.amountRaw.toString(), wallet, args.dayUtc);
    return;
  }
  db.prepare(
    `
      UPDATE leader_budgets
      SET
        reserved_spend_pusd_raw = CAST(reserved_spend_pusd_raw AS INTEGER) - CAST(? AS INTEGER),
        updated_at = datetime('now')
      WHERE source_wallet = ? AND day_utc = ?
    `
  ).run(args.amountRaw.toString(), wallet, args.dayUtc);
}

export function settleLeaderBudgetReservation(
  db: SqliteDatabase,
  args: { sourceWallet: HexAddress; dayUtc: string; reservedRaw: bigint; realizedRaw: bigint; nowIso: string }
): void {
  if (args.reservedRaw < 0n || args.realizedRaw < 0n) {
    throw new Error("leader budget settlement amounts must be nonnegative");
  }
  const wallet = getAddress(args.sourceWallet);
  db.prepare(
    `
      UPDATE leader_budgets
      SET
        reserved_spend_pusd_raw =
          CASE
            WHEN CAST(reserved_spend_pusd_raw AS INTEGER) <= CAST(@reservedRaw AS INTEGER) THEN '0'
            ELSE CAST(CAST(reserved_spend_pusd_raw AS INTEGER) - CAST(@reservedRaw AS INTEGER) AS TEXT)
          END,
        realized_spend_pusd_raw =
          CAST(CAST(realized_spend_pusd_raw AS INTEGER) + CAST(@realizedRaw AS INTEGER) AS TEXT),
        updated_at = @nowIso
      WHERE source_wallet = @sourceWallet AND day_utc = @dayUtc
    `
  ).run({
    sourceWallet: wallet,
    dayUtc: args.dayUtc,
    reservedRaw: args.reservedRaw.toString(),
    realizedRaw: args.realizedRaw.toString(),
    nowIso: args.nowIso
  });
}
