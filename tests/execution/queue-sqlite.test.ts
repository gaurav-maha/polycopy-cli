import type { TempDb } from "../helpers/temp-db.js";
import { createMigratedTempDb } from "../helpers/temp-db.js";
import { cleanupQueueOverflowCreatedRows } from "../../src/execution/queue.js";
import { insertCopyDecision, insertExecutionGraph } from "./sqlite-fixtures.js";

describe("SQLite queue overflow cleanup", () => {
  let tempDb: TempDb;

  afterEach(async () => {
    await tempDb?.cleanup();
  });

  it("atomically cancels only oldest CREATED rows, releases reservations, erases payloads, and skips the current decision", async () => {
    tempDb = await createMigratedTempDb();
    insertExecutionGraph(tempDb.db, {
      groupId: "group-submitting",
      decisionId: "decision-submitting",
      orderId: "order-submitting",
      reservationId: "reservation-submitting",
      currentState: "SUBMITTING",
      createdAt: "2026-05-22T10:00:00.000Z"
    });
    insertExecutionGraph(tempDb.db, {
      groupId: "group-created-oldest",
      decisionId: "decision-created-oldest",
      orderId: "order-created-oldest",
      reservationId: "reservation-created-oldest",
      currentState: "CREATED",
      createdAt: "2026-05-22T10:01:00.000Z",
      intendedSizeRaw: "111"
    });
    insertExecutionGraph(tempDb.db, {
      groupId: "group-timeout",
      decisionId: "decision-timeout",
      orderId: "order-timeout",
      reservationId: "reservation-timeout",
      currentState: "TIMEOUT_UNKNOWN",
      createdAt: "2026-05-22T10:02:00.000Z"
    });
    insertExecutionGraph(tempDb.db, {
      groupId: "group-created-newest",
      decisionId: "decision-created-newest",
      orderId: "order-created-newest",
      reservationId: "reservation-created-newest",
      currentState: "CREATED",
      createdAt: "2026-05-22T10:03:00.000Z",
      intendedSizeRaw: "222"
    });
    insertCopyDecision(tempDb.db, {
      groupId: "group-current",
      decisionId: "decision-current"
    });

    const result = cleanupQueueOverflowCreatedRows(tempDb.db, {
      maxPendingSubmissions: 3,
      incomingDecisionId: "decision-current",
      nowIso: "2026-05-22T12:00:00.000Z"
    });

    expect(result).toEqual({
      overflow: true,
      cancelledOrderSubmissionIds: ["order-created-oldest", "order-created-newest"],
      currentDecisionSkipped: true,
      circuitBreaker: "QUEUE_OVERFLOW"
    });
    expect(
      tempDb.db
        .prepare(
          `
            SELECT id, current_state, encrypted_signed_payload_json, filled_size_raw, abandoned_size_raw, payload_erased_at
            FROM order_submissions
            ORDER BY created_at
          `
        )
        .all()
    ).toEqual([
      {
        id: "order-submitting",
        current_state: "SUBMITTING",
        encrypted_signed_payload_json: '{"ciphertext":"payload"}',
        filled_size_raw: "0",
        abandoned_size_raw: "0",
        payload_erased_at: null
      },
      {
        id: "order-created-oldest",
        current_state: "CANCELLED",
        encrypted_signed_payload_json: null,
        filled_size_raw: "0",
        abandoned_size_raw: "111",
        payload_erased_at: "2026-05-22T12:00:00.000Z"
      },
      {
        id: "order-timeout",
        current_state: "TIMEOUT_UNKNOWN",
        encrypted_signed_payload_json: '{"ciphertext":"payload"}',
        filled_size_raw: "0",
        abandoned_size_raw: "0",
        payload_erased_at: null
      },
      {
        id: "order-created-newest",
        current_state: "CANCELLED",
        encrypted_signed_payload_json: null,
        filled_size_raw: "0",
        abandoned_size_raw: "222",
        payload_erased_at: "2026-05-22T12:00:00.000Z"
      }
    ]);
    expect(
      tempDb.db
        .prepare("SELECT id, status, skip_reason FROM copy_decisions WHERE id IN (?, ?, ?) ORDER BY id")
        .all("decision-created-newest", "decision-created-oldest", "decision-current")
    ).toEqual([
      { id: "decision-created-newest", status: "SKIPPED", skip_reason: "QUEUE_OVERFLOW" },
      { id: "decision-created-oldest", status: "SKIPPED", skip_reason: "QUEUE_OVERFLOW" },
      { id: "decision-current", status: "SKIPPED", skip_reason: "QUEUE_OVERFLOW" }
    ]);
    expect(
      tempDb.db
        .prepare("SELECT id, state, released_at FROM risk_reservations ORDER BY id")
        .all()
    ).toEqual([
      { id: "reservation-created-newest", state: "RELEASED", released_at: "2026-05-22T12:00:00.000Z" },
      { id: "reservation-created-oldest", state: "RELEASED", released_at: "2026-05-22T12:00:00.000Z" },
      { id: "reservation-submitting", state: "ACTIVE", released_at: null },
      { id: "reservation-timeout", state: "ACTIVE", released_at: null }
    ]);
    expect(
      tempDb.db.prepare("SELECT order_submission_id, from_state, to_state, action, error_code FROM order_attempts ORDER BY order_submission_id").all()
    ).toEqual([
      {
        order_submission_id: "order-created-newest",
        from_state: "CREATED",
        to_state: "CANCELLED",
        action: "QUEUE_OVERFLOW_CANCEL",
        error_code: "QUEUE_OVERFLOW"
      },
      {
        order_submission_id: "order-created-oldest",
        from_state: "CREATED",
        to_state: "CANCELLED",
        action: "QUEUE_OVERFLOW_CANCEL",
        error_code: "QUEUE_OVERFLOW"
      }
    ]);
    expect(tempDb.db.prepare("SELECT COUNT(*) AS count FROM order_submissions").get()).toEqual({ count: 4 });
    expect(JSON.parse((tempDb.db.prepare("SELECT value FROM runtime_state WHERE key = ?").get("circuit_breaker.QUEUE_OVERFLOW") as { value: string }).value)).toEqual({
      breaker: "QUEUE_OVERFLOW",
      threshold: 1,
      currentCount: 1,
      lastEventAt: "2026-05-22T12:00:00.000Z",
      resetReason: null
    });
  });

  it("does not mutate rows when the pending queue remains within capacity", async () => {
    tempDb = await createMigratedTempDb();
    insertExecutionGraph(tempDb.db, {
      groupId: "group-created",
      decisionId: "decision-created",
      orderId: "order-created",
      reservationId: "reservation-created",
      currentState: "CREATED"
    });
    insertCopyDecision(tempDb.db, {
      groupId: "group-current-no-overflow",
      decisionId: "decision-current-no-overflow"
    });

    const result = cleanupQueueOverflowCreatedRows(tempDb.db, {
      maxPendingSubmissions: 2,
      incomingDecisionId: "decision-current-no-overflow",
      nowIso: "2026-05-22T12:00:00.000Z"
    });

    expect(result).toEqual({
      overflow: false,
      cancelledOrderSubmissionIds: [],
      currentDecisionSkipped: false,
      circuitBreaker: null
    });
    expect(tempDb.db.prepare("SELECT current_state, encrypted_signed_payload_json FROM order_submissions WHERE id = ?").get("order-created")).toEqual({
      current_state: "CREATED",
      encrypted_signed_payload_json: '{"ciphertext":"payload"}'
    });
    expect(tempDb.db.prepare("SELECT status, skip_reason FROM copy_decisions WHERE id = ?").get("decision-current-no-overflow")).toEqual({
      status: "ACTIVE",
      skip_reason: null
    });
    expect(tempDb.db.prepare("SELECT COUNT(*) AS count FROM order_attempts").get()).toEqual({ count: 0 });
  });
});
