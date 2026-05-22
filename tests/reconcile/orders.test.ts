import { afterEach, describe, expect, it } from "vitest";
import type { Hex, OrderStatusResult } from "../../src/adapters/types.js";
import { MockClobRestAdapter, MockClock, MockRpcAdapter } from "../../src/adapters/mocks.js";
import { CTF } from "../../src/constants/chain.js";
import { reconcileOrderSubmissionStatus } from "../../src/reconcile/orders.js";
import type { TempDb } from "../helpers/temp-db.js";
import { createMigratedTempDb } from "../helpers/temp-db.js";
import { insertExecutionGraph } from "../execution/sqlite-fixtures.js";

const owner = "0x1111111111111111111111111111111111111111" as const;
const nowIso = "2026-05-22T12:00:00.000Z";
const tokenId = "123456789";

describe("order status reconciliation", () => {
  let tempDb: TempDb | undefined;

  afterEach(async () => {
    await tempDb?.cleanup();
    tempDb = undefined;
  });

  it("acknowledges fully matched fills and reconciles filled tokens on-chain", async () => {
    tempDb = await createMigratedTempDb();
    insertExecutionGraph(tempDb.db, {
      groupId: "group-matched",
      decisionId: "decision-matched",
      orderId: "order-matched",
      reservationId: "reservation-matched",
      currentState: "SUBMITTED",
      intendedSizeRaw: "100"
    });
    const signedOrderHash = readSignedOrderHash(tempDb, "order-matched");
    const clock = new MockClock(Date.UTC(2026, 4, 22, 12));
    const clob = new MockClobRestAdapter({
      clock,
      orderStatuses: {
        [signedOrderHash]: orderStatus("matched", [
          {
            tradeId: "trade-1",
            fillHash: "fill-1",
            pricePpm: 500_000,
            sizeRaw: "40",
            pUsdDeltaRaw: "-20",
            feeRaw: "1",
            occurredAt: nowIso
          },
          {
            tradeId: "trade-2",
            fillHash: "fill-2",
            pricePpm: 500_000,
            sizeRaw: "60",
            pUsdDeltaRaw: "-30",
            feeRaw: "1",
            occurredAt: nowIso
          }
        ])
      }
    });
    const rpc = new MockRpcAdapter({
      clock,
      contractReads: {
        [contractReadKey(CTF, "balanceOf", [owner, tokenId])]: 100n
      }
    });

    const result = await reconcileOrderSubmissionStatus(tempDb.db, {
      clob,
      rpc,
      owner,
      orderSubmissionId: "order-matched",
      nowIso
    });

    expect(result).toMatchObject({
      outcome: "ACK_FILLED",
      clobStatus: "matched",
      fillCount: 2,
      tokenIds: [tokenId],
      reconciliation: { status: "OK", divergences: [] }
    });
    expect(orderSummary(tempDb, "order-matched")).toEqual({
      current_state: "ACK_FILLED",
      filled_size_raw: "100",
      abandoned_size_raw: "0",
      encrypted_signed_payload_json: null,
      payload_erased_at: nowIso
    });
    expect(tempDb.db.prepare("SELECT COUNT(*) AS count FROM follower_fills").get()).toEqual({ count: 2 });
    expect(tempDb.db.prepare("SELECT run_type, status FROM reconciliation_runs").get()).toEqual({
      run_type: "POST_FILL",
      status: "OK"
    });
    expect(tempDb.db.prepare("SELECT state, released_at FROM risk_reservations WHERE id = ?").get("reservation-matched")).toEqual({
      state: "RELEASED",
      released_at: nowIso
    });
  });

  it("acknowledges partial filled status when fills do not cover intended size", async () => {
    tempDb = await createMigratedTempDb();
    insertExecutionGraph(tempDb.db, {
      groupId: "group-partial",
      decisionId: "decision-partial",
      orderId: "order-partial",
      reservationId: "reservation-partial",
      currentState: "SUBMITTED",
      intendedSizeRaw: "100"
    });
    const signedOrderHash = readSignedOrderHash(tempDb, "order-partial");
    const clock = new MockClock(Date.UTC(2026, 4, 22, 12));
    const clob = new MockClobRestAdapter({
      clock,
      orderStatuses: {
        [signedOrderHash]: orderStatus("filled", [
          {
            tradeId: "trade-partial",
            fillHash: "fill-partial",
            pricePpm: 500_000,
            sizeRaw: "40",
            pUsdDeltaRaw: "-20",
            feeRaw: "0",
            occurredAt: nowIso
          }
        ])
      }
    });
    const rpc = new MockRpcAdapter({
      clock,
      contractReads: {
        [contractReadKey(CTF, "balanceOf", [owner, tokenId])]: 40n
      }
    });

    const result = await reconcileOrderSubmissionStatus(tempDb.db, {
      clob,
      rpc,
      owner,
      orderSubmissionId: "order-partial",
      nowIso
    });

    expect(result).toMatchObject({
      outcome: "ACK_PARTIAL",
      clobStatus: "filled",
      fillCount: 1,
      tokenIds: [tokenId],
      reconciliation: { status: "OK", divergences: [] }
    });
    expect(orderSummary(tempDb, "order-partial")).toMatchObject({
      current_state: "ACK_PARTIAL",
      filled_size_raw: "40",
      abandoned_size_raw: "60"
    });
    expect(tempDb.db.prepare("SELECT shares_raw, expected_onchain_shares_raw FROM positions WHERE token_id = ?").get(tokenId)).toEqual({
      shares_raw: "40",
      expected_onchain_shares_raw: "40"
    });
  });

  it.each(["unknown", "live", "unmatched", "delayed"] as const)(
    "keeps %s status uncertain without terminal accounting",
    async (status) => {
      tempDb = await createMigratedTempDb();
      insertExecutionGraph(tempDb.db, {
        groupId: `group-${status}`,
        decisionId: `decision-${status}`,
        orderId: `order-${status}`,
        reservationId: `reservation-${status}`,
        currentState: "TIMEOUT_UNKNOWN",
        intendedSizeRaw: "100"
      });
      const signedOrderHash = readSignedOrderHash(tempDb, `order-${status}`);
      const clock = new MockClock(Date.UTC(2026, 4, 22, 12));
      const clob = new MockClobRestAdapter({
        clock,
        orderStatuses: {
          [signedOrderHash]: orderStatus(status, [])
        }
      });
      const rpc = new MockRpcAdapter({ clock });

      const result = await reconcileOrderSubmissionStatus(tempDb.db, {
        clob,
        rpc,
        owner,
        orderSubmissionId: `order-${status}`,
        nowIso
      });

      expect(result).toMatchObject({
        outcome: "UNCERTAIN",
        clobStatus: status,
        fillCount: 0,
        tokenIds: []
      });
      expect(orderSummary(tempDb, `order-${status}`)).toEqual({
        current_state: "TIMEOUT_UNKNOWN",
        filled_size_raw: "0",
        abandoned_size_raw: "0",
        encrypted_signed_payload_json: '{"ciphertext":"payload"}',
        payload_erased_at: null
      });
      expect(tempDb.db.prepare("SELECT COUNT(*) AS count FROM follower_fills").get()).toEqual({ count: 0 });
      expect(tempDb.db.prepare("SELECT COUNT(*) AS count FROM reconciliation_runs").get()).toEqual({ count: 0 });
      expect(tempDb.db.prepare("SELECT state FROM risk_reservations WHERE id = ?").get(`reservation-${status}`)).toEqual({
        state: "ACTIVE"
      });
    }
  );

  it.each([
    ["cancelled", "CANCELLED"],
    ["failed", "FAILED"]
  ] as const)("uses zero-exposure proof for supported %s status without fills", async (status, terminalState) => {
    tempDb = await createMigratedTempDb();
    insertExecutionGraph(tempDb.db, {
      groupId: `group-${status}`,
      decisionId: `decision-${status}`,
      orderId: `order-${status}`,
      reservationId: `reservation-${status}`,
      currentState: "TIMEOUT_UNKNOWN",
      intendedSizeRaw: "100"
    });
    const signedOrderHash = readSignedOrderHash(tempDb, `order-${status}`);
    const clock = new MockClock(Date.UTC(2026, 4, 22, 12));
    const clob = new MockClobRestAdapter({
      clock,
      orderStatuses: {
        [signedOrderHash]: orderStatus(status, [])
      }
    });
    const rpc = new MockRpcAdapter({ clock });

    const result = await reconcileOrderSubmissionStatus(tempDb.db, {
      clob,
      rpc,
      owner,
      orderSubmissionId: `order-${status}`,
      nowIso
    });

    expect(result).toMatchObject({
      outcome: "ZERO_EXPOSURE_TERMINAL",
      clobStatus: status,
      terminalState,
      fillCount: 0,
      tokenIds: []
    });
    expect(orderSummary(tempDb, `order-${status}`)).toEqual({
      current_state: terminalState,
      filled_size_raw: "0",
      abandoned_size_raw: "100",
      encrypted_signed_payload_json: null,
      payload_erased_at: nowIso
    });
    expect(tempDb.db.prepare("SELECT state, released_at FROM risk_reservations WHERE id = ?").get(`reservation-${status}`)).toEqual({
      state: "RELEASED",
      released_at: nowIso
    });
  });

  it("does not force unsupported zero-exposure terminal transitions", async () => {
    tempDb = await createMigratedTempDb();
    insertExecutionGraph(tempDb.db, {
      groupId: "group-unsupported",
      decisionId: "decision-unsupported",
      orderId: "order-unsupported",
      reservationId: "reservation-unsupported",
      currentState: "SUBMITTED",
      intendedSizeRaw: "100"
    });
    const signedOrderHash = readSignedOrderHash(tempDb, "order-unsupported");
    const clock = new MockClock(Date.UTC(2026, 4, 22, 12));
    const clob = new MockClobRestAdapter({
      clock,
      orderStatuses: {
        [signedOrderHash]: orderStatus("cancelled", [])
      }
    });
    const rpc = new MockRpcAdapter({ clock });

    const result = await reconcileOrderSubmissionStatus(tempDb.db, {
      clob,
      rpc,
      owner,
      orderSubmissionId: "order-unsupported",
      nowIso
    });

    expect(result).toMatchObject({
      outcome: "UNSUPPORTED_ZERO_EXPOSURE_TERMINAL",
      clobStatus: "cancelled",
      terminalState: "CANCELLED",
      fillCount: 0,
      tokenIds: []
    });
    expect(orderSummary(tempDb, "order-unsupported")).toMatchObject({
      current_state: "SUBMITTED",
      filled_size_raw: "0",
      abandoned_size_raw: "0"
    });
    expect(tempDb.db.prepare("SELECT COUNT(*) AS count FROM order_attempts WHERE order_submission_id = ?").get("order-unsupported")).toEqual({
      count: 0
    });
  });
});

function readSignedOrderHash(tempDb: TempDb, orderSubmissionId: string): Hex {
  const row = tempDb.db
    .prepare("SELECT signed_order_hash FROM order_submissions WHERE id = ?")
    .get(orderSubmissionId) as { signed_order_hash: Hex };
  return row.signed_order_hash;
}

function orderStatus(status: OrderStatusResult["status"], fills: OrderStatusResult["fills"]): OrderStatusResult {
  return { status, fills, raw: { fixture: status } };
}

function orderSummary(tempDb: TempDb, orderSubmissionId: string): Record<string, unknown> {
  return tempDb.db
    .prepare(
      `
        SELECT current_state, filled_size_raw, abandoned_size_raw, encrypted_signed_payload_json, payload_erased_at
        FROM order_submissions
        WHERE id = ?
      `
    )
    .get(orderSubmissionId) as Record<string, unknown>;
}

function contractReadKey(address: Hex, functionName: string, args: unknown[]): string {
  return `${address.toLowerCase()}:${functionName}:${JSON.stringify(args, (_, value) =>
    typeof value === "bigint" ? value.toString() : value
  )}`;
}
