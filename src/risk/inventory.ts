import type { SqliteDatabase } from "../db/client.js";
import { availableSellInventoryRaw, loadActiveSellInventoryReservationsRaw } from "./reservations.js";

export type SellInventory = {
  sharesRaw: string;
  activeSellReservedSharesRaw: string;
  lastReconciledAtMs: number;
};

export type LoadSellInventoryResult =
  | {
      ok: true;
      inventory: SellInventory;
    }
  | {
      ok: false;
      reason: "NO_POSITION" | "STALE_POSITION";
    };

type PositionRow = {
  shares_raw: string;
  last_reconciled_at: string | null;
};

function parseReconciledAtMs(lastReconciledAt: string | null): number | null {
  if (lastReconciledAt === null) return null;
  const parsed = Date.parse(lastReconciledAt);
  return Number.isFinite(parsed) ? parsed : null;
}

export function loadSellInventory(
  db: SqliteDatabase,
  args: { tokenId: string; nowMs: number; maxPositionAgeMs: number }
): LoadSellInventoryResult {
  const position = db
    .prepare(
      `
        SELECT shares_raw, last_reconciled_at
        FROM positions
        WHERE token_id = ?
      `
    )
    .get(args.tokenId) as PositionRow | undefined;

  if (!position) {
    return { ok: false, reason: "NO_POSITION" };
  }

  const lastReconciledAtMs = parseReconciledAtMs(position.last_reconciled_at);
  if (lastReconciledAtMs === null || args.nowMs - lastReconciledAtMs > args.maxPositionAgeMs) {
    return { ok: false, reason: "STALE_POSITION" };
  }

  const activeSellReservedSharesRaw = loadActiveSellInventoryReservationsRaw(db, args.tokenId);
  const sharesRaw = availableSellInventoryRaw({
    reconciledSharesRaw: position.shares_raw,
    activeSellReservedSharesRaw
  });

  return {
    ok: true,
    inventory: {
      sharesRaw: sharesRaw.toString(),
      activeSellReservedSharesRaw: activeSellReservedSharesRaw.toString(),
      lastReconciledAtMs
    }
  };
}

export function sellInventoryForGates(
  db: SqliteDatabase,
  args: { tokenId: string; nowMs: number; maxPositionAgeMs: number }
):
  | {
      sharesRaw: string;
      activeSellReservedSharesRaw: string;
      lastReconciledAtMs: number;
    }
  | undefined {
  const loaded = loadSellInventory(db, args);
  if (!loaded.ok) {
    return undefined;
  }
  const position = db
    .prepare("SELECT shares_raw FROM positions WHERE token_id = ?")
    .get(args.tokenId) as { shares_raw: string } | undefined;
  if (!position) {
    return undefined;
  }
  return {
    sharesRaw: position.shares_raw,
    activeSellReservedSharesRaw: loaded.inventory.activeSellReservedSharesRaw,
    lastReconciledAtMs: loaded.inventory.lastReconciledAtMs
  };
}
