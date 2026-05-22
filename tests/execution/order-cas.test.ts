import type { TempDb } from "../helpers/temp-db.js";
import { createMigratedTempDb } from "../helpers/temp-db.js";
import { transitionOrderSubmissionCas } from "../../src/execution/order-cas.js";
import { insertExecutionGraph } from "./sqlite-fixtures.js";

describe("order submission CAS transitions", () => {
  let tempDb: TempDb;

  afterEach(async () => {
    await tempDb?.cleanup();
  });

  it("transitions only from the expected state and appends one order attempt", async () => {
    tempDb = await createMigratedTempDb();
    insertExecutionGraph(tempDb.db, {
      groupId: "group-submit",
      decisionId: "decision-submit",
      orderId: "order-submit",
      reservationId: "reservation-submit",
      currentState: "CREATED"
    });

    const result = transitionOrderSubmissionCas(tempDb.db, {
      orderSubmissionId: "order-submit",
      from: "CREATED",
      to: "SUBMITTING",
      action: "PRE_SUBMIT_GATE_PASSED",
      nowIso: "2026-05-22T12:00:00.000Z"
    });

    expect(result).toEqual({ transitioned: true });
    expect(tempDb.db.prepare("SELECT current_state FROM order_submissions WHERE id = ?").get("order-submit")).toEqual({
      current_state: "SUBMITTING"
    });
    expect(tempDb.db.prepare("SELECT from_state, to_state, action FROM order_attempts WHERE order_submission_id = ?").all("order-submit")).toEqual([
      { from_state: "CREATED", to_state: "SUBMITTING", action: "PRE_SUBMIT_GATE_PASSED" }
    ]);
  });

  it("does not append an attempt when the compare-and-swap state does not match", async () => {
    tempDb = await createMigratedTempDb();
    insertExecutionGraph(tempDb.db, {
      groupId: "group-cas-miss",
      decisionId: "decision-cas-miss",
      orderId: "order-cas-miss",
      reservationId: "reservation-cas-miss",
      currentState: "CREATED"
    });
    const { signed_order_hash: signedOrderHash } = tempDb.db
      .prepare("SELECT signed_order_hash FROM order_submissions WHERE id = ?")
      .get("order-cas-miss") as { signed_order_hash: `0x${string}` };

    expect(() =>
      transitionOrderSubmissionCas(tempDb.db, {
        orderSubmissionId: "order-cas-miss",
        from: "SUBMITTED",
        to: "ACK_FILLED",
        action: "ACK_FILLED",
        nowIso: "2026-05-22T12:00:00.000Z",
        followerFills: [
          {
            orderSubmissionId: "order-cas-miss",
            signedOrderHash,
            fillHash: "fill-cas-miss",
            side: "BUY",
            tokenId: "123456789",
            pricePpm: "500000",
            sizeRaw: "40",
            pUsdDeltaRaw: "-20",
            feeRaw: "0",
            occurredAt: "2026-05-22T12:00:00.000Z"
          }
        ]
      })
    ).toThrow(/CAS transition failed/);

    expect(tempDb.db.prepare("SELECT current_state FROM order_submissions WHERE id = ?").get("order-cas-miss")).toEqual({
      current_state: "CREATED"
    });
    expect(tempDb.db.prepare("SELECT COUNT(*) AS count FROM order_attempts WHERE order_submission_id = ?").get("order-cas-miss")).toEqual({
      count: 0
    });
  });

  it("keeps TIMEOUT_UNKNOWN uncertain when FAILED lacks zero-exposure proof", async () => {
    tempDb = await createMigratedTempDb();
    insertExecutionGraph(tempDb.db, {
      groupId: "group-timeout-failed",
      decisionId: "decision-timeout-failed",
      orderId: "order-timeout-failed",
      reservationId: "reservation-timeout-failed",
      currentState: "TIMEOUT_UNKNOWN"
    });

    expect(() =>
      transitionOrderSubmissionCas(tempDb.db, {
        orderSubmissionId: "order-timeout-failed",
        from: "TIMEOUT_UNKNOWN",
        to: "FAILED",
        action: "TIMEOUT_RECOVERY_FAILED",
        zeroExposureProof: false,
        nowIso: "2026-05-22T12:00:00.000Z"
      })
    ).toThrow(/zeroExposureProof/);

    expect(
      tempDb.db
        .prepare("SELECT current_state, encrypted_signed_payload_json FROM order_submissions WHERE id = ?")
        .get("order-timeout-failed")
    ).toEqual({
      current_state: "TIMEOUT_UNKNOWN",
      encrypted_signed_payload_json: '{"ciphertext":"payload"}'
    });
    expect(tempDb.db.prepare("SELECT state FROM risk_reservations WHERE id = ?").get("reservation-timeout-failed")).toEqual({
      state: "ACTIVE"
    });
    expect(tempDb.db.prepare("SELECT COUNT(*) AS count FROM order_attempts WHERE order_submission_id = ?").get("order-timeout-failed")).toEqual({
      count: 0
    });
  });

  it("keeps TIMEOUT_UNKNOWN uncertain when ACK_REJECTED lacks zero-exposure proof", async () => {
    tempDb = await createMigratedTempDb();
    insertExecutionGraph(tempDb.db, {
      groupId: "group-timeout-rejected",
      decisionId: "decision-timeout-rejected",
      orderId: "order-timeout-rejected",
      reservationId: "reservation-timeout-rejected",
      currentState: "TIMEOUT_UNKNOWN"
    });

    expect(() =>
      transitionOrderSubmissionCas(tempDb.db, {
        orderSubmissionId: "order-timeout-rejected",
        from: "TIMEOUT_UNKNOWN",
        to: "ACK_REJECTED",
        action: "TIMEOUT_RECOVERY_REJECTED",
        zeroExposureProof: false,
        nowIso: "2026-05-22T12:00:00.000Z"
      })
    ).toThrow(/zeroExposureProof/);

    expect(
      tempDb.db
        .prepare("SELECT current_state, encrypted_signed_payload_json FROM order_submissions WHERE id = ?")
        .get("order-timeout-rejected")
    ).toEqual({
      current_state: "TIMEOUT_UNKNOWN",
      encrypted_signed_payload_json: '{"ciphertext":"payload"}'
    });
    expect(tempDb.db.prepare("SELECT state FROM risk_reservations WHERE id = ?").get("reservation-timeout-rejected")).toEqual({
      state: "ACTIVE"
    });
    expect(tempDb.db.prepare("SELECT COUNT(*) AS count FROM order_attempts WHERE order_submission_id = ?").get("order-timeout-rejected")).toEqual({
      count: 0
    });
  });

  it("allows TIMEOUT_UNKNOWN to become CANCELLED only with zero-exposure cleanup", async () => {
    tempDb = await createMigratedTempDb();
    insertExecutionGraph(tempDb.db, {
      groupId: "group-timeout-cancel",
      decisionId: "decision-timeout-cancel",
      orderId: "order-timeout-cancel",
      reservationId: "reservation-timeout-cancel",
      currentState: "TIMEOUT_UNKNOWN",
      intendedSizeRaw: "9000"
    });

    transitionOrderSubmissionCas(tempDb.db, {
      orderSubmissionId: "order-timeout-cancel",
      from: "TIMEOUT_UNKNOWN",
      to: "CANCELLED",
      action: "TIMEOUT_ZERO_EXPOSURE_CANCEL",
      zeroExposureProof: true,
      nowIso: "2026-05-22T12:00:00.000Z"
    });

    expect(
      tempDb.db
        .prepare(
          `
            SELECT current_state, filled_size_raw, abandoned_size_raw, encrypted_signed_payload_json, payload_erased_at
            FROM order_submissions
            WHERE id = ?
          `
        )
        .get("order-timeout-cancel")
    ).toEqual({
      current_state: "CANCELLED",
      filled_size_raw: "0",
      abandoned_size_raw: "9000",
      encrypted_signed_payload_json: null,
      payload_erased_at: "2026-05-22T12:00:00.000Z"
    });
    expect(tempDb.db.prepare("SELECT state, released_at FROM risk_reservations WHERE id = ?").get("reservation-timeout-cancel")).toEqual({
      state: "RELEASED",
      released_at: "2026-05-22T12:00:00.000Z"
    });
    expect(tempDb.db.prepare("SELECT from_state, to_state, action FROM order_attempts WHERE order_submission_id = ?").all("order-timeout-cancel")).toEqual([
      { from_state: "TIMEOUT_UNKNOWN", to_state: "CANCELLED", action: "TIMEOUT_ZERO_EXPOSURE_CANCEL" }
    ]);
  });

  it("atomically records fills, updates positions, releases reservations, and erases payload on ACK_FILLED", async () => {
    tempDb = await createMigratedTempDb();
    insertExecutionGraph(tempDb.db, {
      groupId: "group-filled",
      decisionId: "decision-filled",
      orderId: "order-filled",
      reservationId: "reservation-filled",
      currentState: "SUBMITTED",
      intendedSizeRaw: "40"
    });
    const { signed_order_hash: signedOrderHash } = tempDb.db
      .prepare("SELECT signed_order_hash FROM order_submissions WHERE id = ?")
      .get("order-filled") as { signed_order_hash: `0x${string}` };

    transitionOrderSubmissionCas(tempDb.db, {
      orderSubmissionId: "order-filled",
      from: "SUBMITTED",
      to: "ACK_FILLED",
      action: "ACK_FILLED",
      nowIso: "2026-05-22T12:00:00.000Z",
      followerFills: [
        {
          orderSubmissionId: "order-filled",
          signedOrderHash,
          clobFillId: "trade-filled",
          fillHash: "fill-filled",
          side: "BUY",
          tokenId: "123456789",
          pricePpm: "500000",
          sizeRaw: "40",
          pUsdDeltaRaw: "-20",
          feeRaw: "1",
          occurredAt: "2026-05-22T12:00:00.000Z"
        }
      ]
    });

    expect(
      tempDb.db
        .prepare(
          `
            SELECT current_state, filled_size_raw, abandoned_size_raw, encrypted_signed_payload_json, payload_erased_at
            FROM order_submissions
            WHERE id = ?
          `
        )
        .get("order-filled")
    ).toEqual({
      current_state: "ACK_FILLED",
      filled_size_raw: "40",
      abandoned_size_raw: "0",
      encrypted_signed_payload_json: null,
      payload_erased_at: "2026-05-22T12:00:00.000Z"
    });
    expect(tempDb.db.prepare("SELECT state, released_at FROM risk_reservations WHERE id = ?").get("reservation-filled")).toEqual({
      state: "RELEASED",
      released_at: "2026-05-22T12:00:00.000Z"
    });
    expect(tempDb.db.prepare("SELECT COUNT(*) AS count FROM follower_fills").get()).toEqual({ count: 1 });
    expect(tempDb.db.prepare("SELECT movement_type, shares_delta_raw, p_usd_delta_raw FROM position_movements").get()).toEqual({
      movement_type: "BUY_FILL",
      shares_delta_raw: "40",
      p_usd_delta_raw: "-20"
    });
    expect(tempDb.db.prepare("SELECT shares_raw, expected_onchain_shares_raw FROM positions WHERE token_id = ?").get("123456789")).toEqual({
      shares_raw: "40",
      expected_onchain_shares_raw: "40"
    });
  });
});
