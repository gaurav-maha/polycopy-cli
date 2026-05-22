import type { ClobRestAdapter, Hex, OrderStatusResult, RpcAdapter } from "../adapters/types.js";
import type { SqliteDatabase } from "../db/client.js";
import type { OrderSubmissionState } from "../execution/state-machine.js";
import { transitionOrderSubmissionCas } from "../execution/order-cas.js";
import { reconcileOnchainPositions, type FollowerFillInput, type ReconcileOnchainPositionsResult } from "./positions.js";

type OrderSubmissionRow = {
  id: string;
  signed_order_hash: Hex;
  current_state: OrderSubmissionState;
  intended_size_raw: string;
};

export type ReconcileOrderSubmissionStatusResult =
  | {
      outcome: "ACK_FILLED" | "ACK_PARTIAL";
      clobStatus: OrderStatusResult["status"];
      fillCount: number;
      tokenIds: string[];
      reconciliation: ReconcileOnchainPositionsResult;
    }
  | {
      outcome: "UNCERTAIN";
      clobStatus: OrderStatusResult["status"];
      fillCount: number;
      tokenIds: string[];
    }
  | {
      outcome: "ZERO_EXPOSURE_TERMINAL" | "UNSUPPORTED_ZERO_EXPOSURE_TERMINAL";
      clobStatus: OrderStatusResult["status"];
      terminalState: "CANCELLED" | "FAILED";
      fillCount: number;
      tokenIds: string[];
    };

export async function reconcileOrderSubmissionStatus(
  db: SqliteDatabase,
  args: {
    clob: ClobRestAdapter;
    rpc: RpcAdapter;
    owner: Hex;
    orderSubmissionId: string;
    nowIso: string;
  }
): Promise<ReconcileOrderSubmissionStatusResult> {
  const order = readOrderSubmission(db, args.orderSubmissionId);
  const status = await args.clob.getOrderByHash(order.signed_order_hash);
  const followerFills = status.fills.map((fill) => ({
    orderSubmissionId: order.id,
    signedOrderHash: order.signed_order_hash,
    clobFillId: fill.tradeId ?? null,
    fillHash: fill.fillHash,
    side: inferOrderSide(db, order.id),
    tokenId: inferOrderTokenId(db, order.id),
    pricePpm: String(fill.pricePpm),
    sizeRaw: fill.sizeRaw,
    pUsdDeltaRaw: fill.pUsdDeltaRaw,
    feeRaw: fill.feeRaw,
    occurredAt: fill.occurredAt
  })) satisfies FollowerFillInput[];
  const tokenIds = unique(followerFills.map((fill) => fill.tokenId));

  if (followerFills.length > 0) {
    const filledSizeRaw = followerFills.reduce((total, fill) => total + BigInt(fill.sizeRaw), 0n);
    const nextState: "ACK_FILLED" | "ACK_PARTIAL" =
      filledSizeRaw >= BigInt(order.intended_size_raw) ? "ACK_FILLED" : "ACK_PARTIAL";
    transitionOrderSubmissionCas(db, {
      orderSubmissionId: order.id,
      from: order.current_state,
      to: nextState,
      action: nextState,
      nowIso: args.nowIso,
      followerFills
    });
    const reconciliation = await reconcileOnchainPositions(db, args.rpc, {
      owner: args.owner,
      tokenIds,
      nowIso: args.nowIso,
      runType: "POST_FILL"
    });
    return {
      outcome: nextState,
      clobStatus: status.status,
      fillCount: followerFills.length,
      tokenIds,
      reconciliation
    };
  }

  if (isUncertainStatus(status.status)) {
    return { outcome: "UNCERTAIN", clobStatus: status.status, fillCount: 0, tokenIds: [] };
  }

  const terminalState = zeroExposureTerminalState(status.status);
  if (terminalState) {
    if (order.current_state !== "TIMEOUT_UNKNOWN") {
      return {
        outcome: "UNSUPPORTED_ZERO_EXPOSURE_TERMINAL",
        clobStatus: status.status,
        terminalState,
        fillCount: 0,
        tokenIds: []
      };
    }
    transitionOrderSubmissionCas(db, {
      orderSubmissionId: order.id,
      from: order.current_state,
      to: terminalState,
      action: `${status.status.toUpperCase()}_ZERO_EXPOSURE`,
      zeroExposureProof: true,
      nowIso: args.nowIso
    });
    return {
      outcome: "ZERO_EXPOSURE_TERMINAL",
      clobStatus: status.status,
      terminalState,
      fillCount: 0,
      tokenIds: []
    };
  }

  return { outcome: "UNCERTAIN", clobStatus: status.status, fillCount: 0, tokenIds: [] };
}

function readOrderSubmission(db: SqliteDatabase, orderSubmissionId: string): OrderSubmissionRow {
  const row = db
    .prepare(
      `
        SELECT id, signed_order_hash, current_state, intended_size_raw
        FROM order_submissions
        WHERE id = ?
      `
    )
    .get(orderSubmissionId) as OrderSubmissionRow | undefined;
  if (!row) {
    throw new Error(`Order submission not found: ${orderSubmissionId}`);
  }
  return row;
}

function inferOrderSide(db: SqliteDatabase, orderSubmissionId: string): "BUY" | "SELL" {
  const row = db
    .prepare(
      `
        SELECT cd.side
        FROM order_submissions os
        JOIN copy_decisions cd ON cd.id = os.copy_decision_id
        WHERE os.id = ?
      `
    )
    .get(orderSubmissionId) as { side: "BUY" | "SELL" } | undefined;
  if (!row) {
    throw new Error(`Unable to infer side for order submission: ${orderSubmissionId}`);
  }
  return row.side;
}

function inferOrderTokenId(db: SqliteDatabase, orderSubmissionId: string): string {
  const row = db
    .prepare(
      `
        SELECT cd.token_id
        FROM order_submissions os
        JOIN copy_decisions cd ON cd.id = os.copy_decision_id
        WHERE os.id = ?
      `
    )
    .get(orderSubmissionId) as { token_id: string } | undefined;
  if (!row) {
    throw new Error(`Unable to infer token id for order submission: ${orderSubmissionId}`);
  }
  return row.token_id;
}

function isUncertainStatus(status: OrderStatusResult["status"]): boolean {
  return status === "unknown" || status === "live" || status === "unmatched" || status === "delayed";
}

function zeroExposureTerminalState(status: OrderStatusResult["status"]): "CANCELLED" | "FAILED" | null {
  if (status === "cancelled") return "CANCELLED";
  if (status === "failed") return "FAILED";
  return null;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
