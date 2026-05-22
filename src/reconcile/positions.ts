import { createHash, randomUUID } from "node:crypto";
import type { SqliteDatabase } from "../db/client.js";
import type { Hex, RpcAdapter } from "../adapters/types.js";
import { CTF } from "../constants/chain.js";
import { haltLiveTrading } from "../execution/circuit-breaker.js";

const erc1155BalanceOfAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [
      { type: "address", name: "account" },
      { type: "uint256", name: "id" }
    ],
    outputs: [{ type: "uint256" }]
  }
] as const;

type RunType = "STARTUP" | "POST_FILL" | "TIMEOUT_RECOVERY" | "PERIODIC" | "REORG";

export type FollowerFillInput = {
  orderSubmissionId: string;
  signedOrderHash: Hex;
  clobFillId?: string | null;
  fillHash: string;
  side: "BUY" | "SELL";
  tokenId: string;
  pricePpm: string;
  sizeRaw: string;
  pUsdDeltaRaw: string;
  feeRaw: string;
  occurredAt: string;
};

export type RecordFollowerFillsResult = {
  insertedFills: number;
  insertedMovements: number;
};

export type PositionDivergence = {
  tokenId: string;
  expectedRaw: string;
  onchainRaw: string;
  deltaRaw: string;
};

export type PUsdDivergence = {
  expectedRaw: string;
  observedRaw: string;
  deltaRaw: string;
};

export type ReconcileOnchainPositionsResult = {
  runId: string;
  status: "OK" | "DIVERGED";
  divergences: PositionDivergence[];
  pUsdDivergence: PUsdDivergence | null;
};

type PositionRow = {
  shares_raw: string;
  expected_onchain_shares_raw: string;
  last_onchain_shares_raw: string;
};

type StoredFillRow = { id: string } | undefined;

function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex")}`;
}

function toRaw(value: bigint | string | number): string {
  return BigInt(value).toString();
}

function signedDelta(side: "BUY" | "SELL", sizeRaw: string): bigint {
  const size = BigInt(sizeRaw);
  return side === "BUY" ? size : -size;
}

export function recordFollowerFills(
  db: SqliteDatabase,
  args: { fills: FollowerFillInput[] }
): RecordFollowerFillsResult {
  return runBeginImmediate(db, () => recordFollowerFillsInOpenTransaction(db, args));
}

export function recordFollowerFillsInOpenTransaction(
  db: SqliteDatabase,
  args: { fills: FollowerFillInput[] }
): RecordFollowerFillsResult {
  let insertedFills = 0;
  let insertedMovements = 0;

  for (const fill of args.fills) {
    const followerFillId = stableId(
      "ff",
      `${fill.orderSubmissionId}|${fill.signedOrderHash}|${fill.clobFillId ?? ""}|${fill.fillHash}`
    );
    const insertFill = db
      .prepare(
        `
          INSERT OR IGNORE INTO follower_fills (
            id, order_submission_id, signed_order_hash, clob_fill_id, fill_hash,
            side, token_id, price_ppm, size_raw, p_usd_delta_raw, fee_raw, occurred_at
          ) VALUES (
            @id, @orderSubmissionId, @signedOrderHash, @clobFillId, @fillHash,
            @side, @tokenId, @pricePpm, @sizeRaw, @pUsdDeltaRaw, @feeRaw, @occurredAt
          )
        `
      )
      .run({
        id: followerFillId,
        orderSubmissionId: fill.orderSubmissionId,
        signedOrderHash: fill.signedOrderHash,
        clobFillId: fill.clobFillId ?? null,
        fillHash: fill.fillHash,
        side: fill.side,
        tokenId: fill.tokenId,
        pricePpm: fill.pricePpm,
        sizeRaw: fill.sizeRaw,
        pUsdDeltaRaw: fill.pUsdDeltaRaw,
        feeRaw: fill.feeRaw,
        occurredAt: fill.occurredAt
      });
    insertedFills += insertFill.changes;

    const storedFill = readFollowerFill(db, fill, followerFillId);
    if (!storedFill) {
      throw new Error(`Unable to read follower fill after insert: ${fill.signedOrderHash}/${fill.fillHash}`);
    }

    const movementType = fill.side === "BUY" ? "BUY_FILL" : "SELL_FILL";
    const sharesDelta = signedDelta(fill.side, fill.sizeRaw);
    const movementId = stableId("pm", `${storedFill.id}|${movementType}|${fill.tokenId}`);
    const insertMovement = db
      .prepare(
        `
          INSERT OR IGNORE INTO position_movements (
            id, follower_fill_id, movement_type, token_id, shares_delta_raw, p_usd_delta_raw, occurred_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(movementId, storedFill.id, movementType, fill.tokenId, sharesDelta.toString(), fill.pUsdDeltaRaw, fill.occurredAt);

    insertedMovements += insertMovement.changes;
    if (insertMovement.changes === 1) {
      applyFillPositionDelta(db, fill.tokenId, sharesDelta, fill.occurredAt);
    }
  }

  return { insertedFills, insertedMovements };
}

export async function reconcileOnchainPositions(
  db: SqliteDatabase,
  rpc: RpcAdapter,
  args: {
    owner: Hex;
    tokenIds: string[];
    nowIso: string;
    runType: RunType;
    pUsdBalanceRaw?: string;
    startingPUsdBalanceRaw?: string;
    expectedPUsdBalanceRaw?: string;
  }
): Promise<ReconcileOnchainPositionsResult> {
  const observed: Array<{ tokenId: string; onchainRaw: string }> = [];
  for (const tokenId of args.tokenIds) {
    const onchainRaw = await rpc.readContract<bigint | string>({
      address: CTF,
      abi: erc1155BalanceOfAbi,
      functionName: "balanceOf",
      args: [args.owner, tokenId]
    });
    observed.push({ tokenId, onchainRaw: toRaw(onchainRaw) });
  }

  return runBeginImmediate(db, () => {
    const runId = randomUUID();
    const divergences: PositionDivergence[] = [];
    const pUsdDivergence = calculatePUsdDivergence(db, args);

    for (const entry of observed) {
      const position = readPosition(db, entry.tokenId);
      const expected = BigInt(position?.expected_onchain_shares_raw ?? "0");
      const onchain = BigInt(entry.onchainRaw);
      if (!position) {
        insertPosition(db, {
          tokenId: entry.tokenId,
          sharesRaw: "0",
          expectedOnchainSharesRaw: "0",
          lastOnchainSharesRaw: entry.onchainRaw,
          lastReconciledAt: args.nowIso
        });
      } else {
        db.prepare(
          `
            UPDATE positions
            SET last_onchain_shares_raw = ?, last_reconciled_at = ?, updated_at = ?
            WHERE token_id = ?
          `
        ).run(entry.onchainRaw, args.nowIso, args.nowIso, entry.tokenId);
      }

      if (expected !== onchain) {
        divergences.push({
          tokenId: entry.tokenId,
          expectedRaw: expected.toString(),
          onchainRaw: onchain.toString(),
          deltaRaw: (onchain - expected).toString()
        });
      }
    }

    const status = divergences.length === 0 && !pUsdDivergence ? "OK" : "DIVERGED";
    const details = { owner: args.owner, tokenIds: args.tokenIds, observed, divergences, pUsdDivergence };
    db.prepare(
      `
        INSERT INTO reconciliation_runs (id, run_type, status, p_usd_balance_raw, details_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `
    ).run(runId, args.runType, status, args.pUsdBalanceRaw ?? null, JSON.stringify(details), args.nowIso);

    if (status === "DIVERGED") {
      for (const divergence of divergences) {
        insertReconciliationAdjustment(db, {
          runId,
          tokenId: divergence.tokenId,
          sharesDeltaRaw: divergence.deltaRaw,
          occurredAt: args.nowIso
        });
      }
      db.prepare(
        `
          INSERT OR REPLACE INTO runtime_state (key, value, updated_at)
          VALUES (?, ?, ?)
        `
      ).run(
        "live_halt_reconciliation_divergence",
        JSON.stringify({ runId, status, divergences, pUsdDivergence, at: args.nowIso }),
        args.nowIso
      );
      haltLiveTrading(db, "RECONCILIATION_DIVERGENCE", { runId, status, divergences, pUsdDivergence }, args.nowIso);
    } else {
      db.prepare("DELETE FROM runtime_state WHERE key = ?").run("live_halt_reconciliation_divergence");
      db.prepare("DELETE FROM runtime_state WHERE key = ?").run("live_halt.RECONCILIATION_DIVERGENCE");
    }

    return { runId, status, divergences, pUsdDivergence };
  });
}

function calculatePUsdDivergence(
  db: SqliteDatabase,
  args: { pUsdBalanceRaw?: string; startingPUsdBalanceRaw?: string; expectedPUsdBalanceRaw?: string }
): PUsdDivergence | null {
  if (args.pUsdBalanceRaw === undefined) {
    return null;
  }
  const expectedRaw =
    args.expectedPUsdBalanceRaw ??
    (args.startingPUsdBalanceRaw === undefined ? undefined : calculateExpectedPUsdBalanceRaw(db, args.startingPUsdBalanceRaw));
  if (expectedRaw === undefined) {
    return null;
  }
  const expected = BigInt(expectedRaw);
  const observed = BigInt(args.pUsdBalanceRaw);
  if (expected === observed) {
    return null;
  }
  return {
    expectedRaw: expected.toString(),
    observedRaw: observed.toString(),
    deltaRaw: (observed - expected).toString()
  };
}

function calculateExpectedPUsdBalanceRaw(db: SqliteDatabase, startingPUsdBalanceRaw: string): string {
  const row = db
    .prepare(
      `
        SELECT
          COALESCE(SUM(CAST(p_usd_delta_raw AS INTEGER)), 0) AS p_usd_delta,
          COALESCE(SUM(CAST(fee_raw AS INTEGER)), 0) AS fees
        FROM follower_fills
      `
    )
    .get() as { p_usd_delta: number; fees: number };
  return (BigInt(startingPUsdBalanceRaw) + BigInt(row.p_usd_delta) - BigInt(row.fees)).toString();
}

function readFollowerFill(db: SqliteDatabase, fill: FollowerFillInput, fallbackId: string): StoredFillRow {
  if (fill.clobFillId) {
    const byClobId = db.prepare("SELECT id FROM follower_fills WHERE clob_fill_id = ?").get(fill.clobFillId) as StoredFillRow;
    if (byClobId) return byClobId;
  }
  return db
    .prepare("SELECT id FROM follower_fills WHERE id = ? OR (signed_order_hash = ? AND fill_hash = ?)")
    .get(fallbackId, fill.signedOrderHash, fill.fillHash) as StoredFillRow;
}

function readPosition(db: SqliteDatabase, tokenId: string): PositionRow | undefined {
  return db
    .prepare(
      `
        SELECT shares_raw, expected_onchain_shares_raw, last_onchain_shares_raw
        FROM positions
        WHERE token_id = ?
      `
    )
    .get(tokenId) as PositionRow | undefined;
}

function insertPosition(
  db: SqliteDatabase,
  args: {
    tokenId: string;
    sharesRaw: string;
    expectedOnchainSharesRaw: string;
    lastOnchainSharesRaw: string;
    lastReconciledAt: string | null;
  }
): void {
  db.prepare(
    `
      INSERT INTO positions (
        token_id, shares_raw, expected_onchain_shares_raw, last_onchain_shares_raw, last_reconciled_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, datetime('now'))
    `
  ).run(args.tokenId, args.sharesRaw, args.expectedOnchainSharesRaw, args.lastOnchainSharesRaw, args.lastReconciledAt);
}

function applyFillPositionDelta(db: SqliteDatabase, tokenId: string, sharesDeltaRaw: bigint, updatedAt: string): void {
  const current = readPosition(db, tokenId);
  if (!current) {
    const sharesRaw = sharesDeltaRaw.toString();
    insertPosition(db, {
      tokenId,
      sharesRaw,
      expectedOnchainSharesRaw: sharesRaw,
      lastOnchainSharesRaw: "0",
      lastReconciledAt: null
    });
    db.prepare("UPDATE positions SET updated_at = ? WHERE token_id = ?").run(updatedAt, tokenId);
    return;
  }
  const sharesRaw = BigInt(current.shares_raw) + sharesDeltaRaw;
  const expectedOnchainSharesRaw = BigInt(current.expected_onchain_shares_raw) + sharesDeltaRaw;
  db.prepare(
    `
      UPDATE positions
      SET shares_raw = ?, expected_onchain_shares_raw = ?, updated_at = ?
      WHERE token_id = ?
    `
  ).run(sharesRaw.toString(), expectedOnchainSharesRaw.toString(), updatedAt, tokenId);
}

function insertReconciliationAdjustment(
  db: SqliteDatabase,
  args: { runId: string; tokenId: string; sharesDeltaRaw: string; occurredAt: string }
): void {
  db.prepare(
    `
      INSERT INTO position_movements (
        id, reconciliation_run_id, movement_type, token_id, shares_delta_raw, p_usd_delta_raw, occurred_at
      ) VALUES (?, ?, 'RECONCILE_ADJUSTMENT', ?, ?, '0', ?)
    `
  ).run(stableId("pm", `${args.runId}|${args.tokenId}`), args.runId, args.tokenId, args.sharesDeltaRaw, args.occurredAt);
}

function runBeginImmediate<T>(db: SqliteDatabase, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
