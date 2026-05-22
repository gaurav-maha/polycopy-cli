import type { SqliteDatabase } from "../db/client.js";

type RawAmount = bigint | string | number;

function toBigint(raw: RawAmount): bigint {
  return typeof raw === "bigint" ? raw : BigInt(raw);
}

export function pUsdReservationTotalRaw(args: {
  pUsdReservedRaw: RawAmount;
  pUsdFeeReservedRaw: RawAmount;
}): bigint {
  return toBigint(args.pUsdReservedRaw) + toBigint(args.pUsdFeeReservedRaw);
}

export function availableSellInventoryRaw(args: {
  reconciledSharesRaw: RawAmount;
  activeSellReservedSharesRaw?: RawAmount;
}): bigint {
  const available = toBigint(args.reconciledSharesRaw) - toBigint(args.activeSellReservedSharesRaw ?? 0n);
  return available > 0n ? available : 0n;
}

export function loadActivePUsdReservationsRaw(db: SqliteDatabase): bigint {
  const rows = db
    .prepare(
      `
        SELECT p_usd_reserved_raw, p_usd_fee_reserved_raw
        FROM risk_reservations
        WHERE state = 'ACTIVE'
      `
    )
    .all() as Array<{ p_usd_reserved_raw: string; p_usd_fee_reserved_raw: string }>;

  return rows.reduce(
    (total, row) =>
      total +
      pUsdReservationTotalRaw({
        pUsdReservedRaw: row.p_usd_reserved_raw,
        pUsdFeeReservedRaw: row.p_usd_fee_reserved_raw
      }),
    0n
  );
}

export function loadActiveSellInventoryReservationsRaw(db: SqliteDatabase, tokenId: string): bigint {
  const rows = db
    .prepare(
      `
        SELECT inventory_reserved_raw
        FROM risk_reservations
        WHERE state = 'ACTIVE' AND side = 'SELL' AND token_id = ?
      `
    )
    .all(tokenId) as Array<{ inventory_reserved_raw: string }>;

  return rows.reduce((total, row) => total + toBigint(row.inventory_reserved_raw), 0n);
}
