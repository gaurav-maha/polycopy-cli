import { describe, expect, it } from "vitest";
import type { CancelResult, Hex, OrderStatusResult } from "../../src/adapters/types.js";
import { MockClobRestAdapter, MockClock, MockRpcAdapter } from "../../src/adapters/mocks.js";
import { encryptSignedPayload } from "../../src/execution/payload-crypto.js";
import { runStartupOrderRecovery, runOrderRecoveryCycle } from "../../src/execution/recovery.js";
import { insertCopyDecision } from "./sqlite-fixtures.js";
import { createMigratedTempDb, type TempDb } from "../helpers/temp-db.js";

const owner = "0x1111111111111111111111111111111111111111" as Hex;
const signedOrderHash = `0x${"c".repeat(64)}` as Hex;
const nowMs = Date.UTC(2026, 4, 22, 12);
const nowIso = new Date(nowMs).toISOString();
const encryptionKey = new Uint8Array(32).fill(9);

describe("order recovery", () => {
  it("marks SUBMITTING rows as TIMEOUT_UNKNOWN at startup", async () => {
    const tempDb = await createMigratedTempDb();
    insertCopyDecision(tempDb.db, { groupId: "ag_submitting", decisionId: "cd_submitting" });
    tempDb.db
      .prepare(
        `
          INSERT INTO order_submissions (
            id, copy_decision_id, signed_order_hash, encrypted_signed_payload_json,
            current_state, order_type, limit_price_ppm, intended_notional_raw, intended_size_raw,
            created_at, updated_at
          )
          VALUES ('os_submitting', 'cd_submitting', ?, '{}', 'SUBMITTING', 'FAK', '500000', '25', '50', ?, ?)
        `
      )
      .run(signedOrderHash, nowIso, nowIso);

    const startup = runStartupOrderRecovery(tempDb.db, { nowIso });
    expect(startup.submittingRecovered).toBe(1);
    expect(tempDb.db.prepare("SELECT current_state FROM order_submissions WHERE id = 'os_submitting'").get()).toEqual({
      current_state: "TIMEOUT_UNKNOWN"
    });
    await tempDb.cleanup();
  });

  it("increments retry_count when retrying TIMEOUT_UNKNOWN with absent hash", async () => {
    const tempDb = await createMigratedTempDb();
    insertCopyDecision(tempDb.db, { groupId: "ag_retry", decisionId: "cd_retry", tokenId: "123456789" });
    tempDb.db.prepare("UPDATE copy_decisions SET gate_snapshot_json = ?, approved_copy_notional_raw = '25' WHERE id = 'cd_retry'").run(
      JSON.stringify({
        leaderPricePpm: 500_000,
        book: { vwapPpm: 500_000, intendedSizeRaw: "50" },
        metadata: { tickSize: "0.01", negRisk: false }
      })
    );
    tempDb.db
      .prepare(
        `
          INSERT INTO order_submissions (
            id, copy_decision_id, signed_order_hash, encrypted_signed_payload_json,
            current_state, order_type, limit_price_ppm, intended_notional_raw, intended_size_raw,
            retry_count, recovery_attempts, created_at, updated_at
          )
          VALUES (
            'os_retry', 'cd_retry', ?, ?,
            'TIMEOUT_UNKNOWN', 'FAK', '500000', '25', '50', 0, 0, ?, ?
          )
        `
      )
      .run(signedOrderHash, encryptedPayload("os_retry"), nowIso, nowIso);

    const clock = new MockClock(nowMs);
    const clob = new MockClobRestAdapter({
      clock,
      books: [
        {
          tokenId: "123456789",
          source: "REST",
          receivedAtMs: nowMs,
          asks: [{ pricePpm: 500_000, sizeRaw: "1000000" }],
          bids: [{ pricePpm: 490_000, sizeRaw: "1000000" }]
        }
      ],
      orderStatuses: {
        [signedOrderHash]: orderStatus("unknown", [])
      },
      submitResults: {
        [signedOrderHash]: {
          success: true,
          errorMsg: "",
          orderID: signedOrderHash,
          status: "matched",
          transactionsHashes: [],
          tradeIDs: [],
          raw: { fixture: true }
        }
      }
    });
    const rpc = new MockRpcAdapter({ clock, contractReads: {} });

    const result = await runOrderRecoveryCycle(tempDb.db, {
      clob,
      rpc,
      owner,
      funder: owner,
      signatureType: 0,
      encryptionKey,
      maxRecoveryAttempts: 5,
      breakerThresholds: {
        consecutiveRejectionsHalt: 5,
        consecutiveTimeoutUnknownHalt: 3,
        staleBookHalt: 5,
        bookSourceMismatchHalt: 3,
        clobUnavailableHalt: 3
      },
      signBoundary: {
        maxBookAgeMs: 800,
        maxDriftPpm: 30_000,
        maxBuyPpm: 980_000,
        minSellPpm: 20_000,
        slippageCapPpm: 50_000
      },
      killSwitchActive: () => false,
      nowIso
    });

    expect(result.retried).toBeGreaterThanOrEqual(1);
    expect(tempDb.db.prepare("SELECT retry_count, recovery_attempts FROM order_submissions WHERE id = 'os_retry'").get()).toEqual({
      retry_count: 1,
      recovery_attempts: 1
    });
    await tempDb.cleanup();
  });

  it("halts instead of retrying a persisted signed payload below the approved BUY size", async () => {
    const tempDb = await createMigratedTempDb();
    insertCopyDecision(tempDb.db, { groupId: "ag_bad_retry", decisionId: "cd_bad_retry", tokenId: "123456789" });
    tempDb.db.prepare("UPDATE copy_decisions SET gate_snapshot_json = ?, approved_copy_notional_raw = '25' WHERE id = 'cd_bad_retry'").run(
      JSON.stringify({
        leaderPricePpm: 500_000,
        book: { vwapPpm: 500_000, intendedSizeRaw: "50" },
        metadata: { tickSize: "0.01", negRisk: false }
      })
    );
    tempDb.db
      .prepare(
        `
          INSERT INTO order_submissions (
            id, copy_decision_id, signed_order_hash, encrypted_signed_payload_json,
            current_state, order_type, limit_price_ppm, intended_notional_raw, intended_size_raw,
            retry_count, recovery_attempts, created_at, updated_at
          )
          VALUES (
            'os_bad_retry', 'cd_bad_retry', ?, ?,
            'TIMEOUT_UNKNOWN', 'FAK', '500000', '25', '50', 0, 0, ?, ?
          )
        `
      )
      .run(signedOrderHash, encryptedPayload("os_bad_retry", { takerAmount: "1" }), nowIso, nowIso);

    const clock = new MockClock(nowMs);
    let submitCalls = 0;
    const clob = new MockClobRestAdapter({
      clock,
      books: [
        {
          tokenId: "123456789",
          source: "REST",
          receivedAtMs: nowMs,
          asks: [{ pricePpm: 500_000, sizeRaw: "1000000" }],
          bids: [{ pricePpm: 490_000, sizeRaw: "1000000" }]
        }
      ],
      orderStatuses: {
        [signedOrderHash]: orderStatus("unknown", [])
      }
    });
    const originalSubmitOrder = clob.submitOrder.bind(clob);
    clob.submitOrder = async (args) => {
      submitCalls += 1;
      return originalSubmitOrder(args);
    };
    const rpc = new MockRpcAdapter({ clock, contractReads: {} });

    const result = await runOrderRecoveryCycle(tempDb.db, {
      clob,
      rpc,
      owner,
      funder: owner,
      signatureType: 0,
      encryptionKey,
      maxRecoveryAttempts: 5,
      breakerThresholds: {
        consecutiveRejectionsHalt: 5,
        consecutiveTimeoutUnknownHalt: 3,
        staleBookHalt: 5,
        bookSourceMismatchHalt: 3,
        clobUnavailableHalt: 3
      },
      signBoundary: {
        maxBookAgeMs: 800,
        maxDriftPpm: 30_000,
        maxBuyPpm: 980_000,
        minSellPpm: 20_000,
        slippageCapPpm: 50_000
      },
      killSwitchActive: () => false,
      nowIso
    });

    expect(result).toMatchObject({
      retried: 0,
      uncertain: 1,
      halted: true,
      haltReason: "SIGNED_ORDER_INVARIANT_VIOLATION"
    });
    expect(submitCalls).toBe(0);
    expect(tempDb.db.prepare("SELECT current_state, retry_count, recovery_attempts, last_error FROM order_submissions WHERE id = 'os_bad_retry'").get()).toEqual({
      current_state: "TIMEOUT_UNKNOWN",
      retry_count: 0,
      recovery_attempts: 0,
      last_error: "SIGNED_BUY_PRICE_ABOVE_LIMIT: limitPricePpm=500000 signedMakerAmountRaw=25 signedTakerAmountRaw=1"
    });
    expect(tempDb.db.prepare("SELECT value FROM runtime_state WHERE key = ?").get("live_halt.SIGNED_ORDER_INVARIANT_VIOLATION")).toEqual({
      value: JSON.stringify({
        reason: "SIGNED_ORDER_INVARIANT_VIOLATION",
        orderSubmissionId: "os_bad_retry",
        error: "SIGNED_BUY_PRICE_ABOVE_LIMIT: limitPricePpm=500000 signedMakerAmountRaw=25 signedTakerAmountRaw=1",
        at: nowIso
      })
    });
    await tempDb.cleanup();
  });

  it("halts when a recovery retry is rejected for account setup", async () => {
    const tempDb = await createMigratedTempDb();
    insertRecoverableTimeoutUnknown(tempDb.db, "cd_account_reject", "os_account_reject");
    const clock = new MockClock(nowMs);
    const clob = new MockClobRestAdapter({
      clock,
      orderStatuses: { [signedOrderHash]: orderStatus("unknown", []) },
      submitResults: {
        [signedOrderHash]: {
          success: false,
          errorMsg: "maker address not allowed, please use the deposit wallet flow",
          orderID: signedOrderHash,
          status: "matched",
          transactionsHashes: [],
          tradeIDs: [],
          raw: { fixture: true }
        }
      }
    });
    const rpc = new MockRpcAdapter({ clock, contractReads: {} });

    const result = await runOrderRecoveryCycle(tempDb.db, {
      clob,
      rpc,
      owner,
      funder: owner,
      signatureType: 0,
      encryptionKey,
      maxRecoveryAttempts: 5,
      breakerThresholds: breakerThresholds(),
      killSwitchActive: () => false,
      nowIso
    });

    expect(result).toMatchObject({ retried: 1, terminal: 1, halted: true, haltReason: "CLOB_ACCOUNT_NOT_ALLOWED" });
    expect(tempDb.db.prepare("SELECT current_state FROM order_submissions WHERE id = 'os_account_reject'").get()).toEqual({
      current_state: "ACK_REJECTED"
    });
    expect(tempDb.db.prepare("SELECT value FROM runtime_state WHERE key = ?").get("live_halt.CLOB_ACCOUNT_NOT_ALLOWED")).toEqual({
      value: JSON.stringify({ reason: "CLOB_ACCOUNT_NOT_ALLOWED", orderSubmissionId: "os_account_reject", at: nowIso })
    });
    await tempDb.cleanup();
  });

  it("cancels and halts when a recovery retry returns an unexpected resting order", async () => {
    const tempDb = await createMigratedTempDb();
    insertRecoverableTimeoutUnknown(tempDb.db, "cd_resting_retry", "os_resting_retry");
    const clock = new MockClock(nowMs);
    const clob = new MockClobRestAdapter({
      clock,
      orderStatuses: { [signedOrderHash]: orderStatus("unknown", []) },
      submitResults: {
        [signedOrderHash]: {
          success: true,
          errorMsg: "",
          orderID: signedOrderHash,
          status: "live",
          transactionsHashes: [],
          tradeIDs: [],
          raw: { fixture: true }
        }
      }
    });
    const rpc = new MockRpcAdapter({ clock, contractReads: {} });

    const result = await runOrderRecoveryCycle(tempDb.db, {
      clob,
      rpc,
      owner,
      funder: owner,
      signatureType: 0,
      encryptionKey,
      maxRecoveryAttempts: 5,
      breakerThresholds: breakerThresholds(),
      killSwitchActive: () => false,
      nowIso
    });

    expect(result).toMatchObject({ retried: 1, uncertain: 1, halted: true, haltReason: "CLOB_LIVE_STATUS_UNEXPECTED" });
    expect(tempDb.db.prepare("SELECT current_state FROM order_submissions WHERE id = 'os_resting_retry'").get()).toEqual({
      current_state: "TIMEOUT_UNKNOWN"
    });
    expect(tempDb.db.prepare("SELECT value FROM runtime_state WHERE key = ?").get("live_halt.CLOB_LIVE_STATUS_UNEXPECTED")).toEqual({
      value: JSON.stringify({ reason: "CLOB_LIVE_STATUS_UNEXPECTED", orderSubmissionId: "os_resting_retry", at: nowIso })
    });
    await tempDb.cleanup();
  });

  it("persists the unexpected-resting recovery halt even when cancel fails", async () => {
    const tempDb = await createMigratedTempDb();
    insertRecoverableTimeoutUnknown(tempDb.db, "cd_cancel_fail_retry", "os_cancel_fail_retry");
    const clock = new MockClock(nowMs);
    class CancelFailingClob extends MockClobRestAdapter {
      async cancelByHash(_signedOrderHash: Hex): Promise<CancelResult> {
        throw new Error("fixture cancel failed");
      }
    }
    const clob = new CancelFailingClob({
      clock,
      orderStatuses: { [signedOrderHash]: orderStatus("unknown", []) },
      submitResults: {
        [signedOrderHash]: {
          success: true,
          errorMsg: "",
          orderID: signedOrderHash,
          status: "live",
          transactionsHashes: [],
          tradeIDs: [],
          raw: { fixture: true }
        }
      }
    });
    const rpc = new MockRpcAdapter({ clock, contractReads: {} });

    const result = await runOrderRecoveryCycle(tempDb.db, {
      clob,
      rpc,
      owner,
      funder: owner,
      signatureType: 0,
      encryptionKey,
      maxRecoveryAttempts: 5,
      breakerThresholds: breakerThresholds(),
      killSwitchActive: () => false,
      nowIso
    });

    expect(result).toMatchObject({ retried: 1, uncertain: 1, halted: true, haltReason: "CLOB_LIVE_STATUS_UNEXPECTED" });
    expect(tempDb.db.prepare("SELECT current_state, last_error FROM order_submissions WHERE id = 'os_cancel_fail_retry'").get()).toEqual({
      current_state: "TIMEOUT_UNKNOWN",
      last_error: "cancelByHash failed after unexpected resting status: fixture cancel failed"
    });
    expect(tempDb.db.prepare("SELECT value FROM runtime_state WHERE key = ?").get("live_halt.CLOB_LIVE_STATUS_UNEXPECTED")).toEqual({
      value: JSON.stringify({ reason: "CLOB_LIVE_STATUS_UNEXPECTED", orderSubmissionId: "os_cancel_fail_retry", at: nowIso })
    });
    await tempDb.cleanup();
  });

  it("allows the last permitted recovery retry attempt", async () => {
    const tempDb = await createMigratedTempDb();
    insertRecoverableTimeoutUnknown(tempDb.db, "cd_last_retry", "os_last_retry", { recoveryAttempts: 4 });
    const clock = new MockClock(nowMs);
    const clob = new MockClobRestAdapter({
      clock,
      orderStatuses: { [signedOrderHash]: orderStatus("unknown", []) },
      submitResults: {
        [signedOrderHash]: {
          success: true,
          errorMsg: "",
          orderID: signedOrderHash,
          status: "delayed",
          transactionsHashes: [],
          tradeIDs: [],
          raw: { fixture: true }
        }
      }
    });
    const rpc = new MockRpcAdapter({ clock, contractReads: {} });

    const result = await runOrderRecoveryCycle(tempDb.db, {
      clob,
      rpc,
      owner,
      funder: owner,
      signatureType: 0,
      encryptionKey,
      maxRecoveryAttempts: 5,
      breakerThresholds: breakerThresholds(),
      killSwitchActive: () => false,
      nowIso
    });

    expect(result).toMatchObject({ retried: 1, halted: false });
    expect(tempDb.db.prepare("SELECT current_state, retry_count, recovery_attempts FROM order_submissions WHERE id = 'os_last_retry'").get()).toEqual({
      current_state: "SUBMITTED",
      retry_count: 1,
      recovery_attempts: 5
    });
    await tempDb.cleanup();
  });

  it("checks the kill switch immediately before recovery retry submit", async () => {
    const tempDb = await createMigratedTempDb();
    insertRecoverableTimeoutUnknown(tempDb.db, "cd_kill_retry", "os_kill_retry");
    const clock = new MockClock(nowMs);
    let submitCalls = 0;
    const clob = new MockClobRestAdapter({
      clock,
      orderStatuses: { [signedOrderHash]: orderStatus("unknown", []) }
    });
    const originalSubmitOrder = clob.submitOrder.bind(clob);
    clob.submitOrder = async (args) => {
      submitCalls += 1;
      return originalSubmitOrder(args);
    };
    const rpc = new MockRpcAdapter({ clock, contractReads: {} });
    let killChecks = 0;

    const result = await runOrderRecoveryCycle(tempDb.db, {
      clob,
      rpc,
      owner,
      funder: owner,
      signatureType: 0,
      encryptionKey,
      maxRecoveryAttempts: 5,
      breakerThresholds: breakerThresholds(),
      killSwitchActive: () => {
        killChecks += 1;
        return killChecks >= 5;
      },
      nowIso
    });

    expect(result).toMatchObject({ retried: 0, terminal: 1, halted: false });
    expect(submitCalls).toBe(0);
    expect(tempDb.db.prepare("SELECT current_state, retry_count, recovery_attempts FROM order_submissions WHERE id = 'os_kill_retry'").get()).toEqual({
      current_state: "CANCELLED",
      retry_count: 1,
      recovery_attempts: 1
    });
    await tempDb.cleanup();
  });
});

function insertRecoverableTimeoutUnknown(
  db: TempDb["db"],
  decisionId: string,
  orderSubmissionId: string,
  options: { recoveryAttempts?: number } = {}
): void {
  insertCopyDecision(db, { groupId: `ag_${decisionId}`, decisionId, tokenId: "123456789" });
  db.prepare("UPDATE copy_decisions SET gate_snapshot_json = ?, approved_copy_notional_raw = '25' WHERE id = ?").run(
    JSON.stringify({
      leaderPricePpm: 500_000,
      book: { vwapPpm: 500_000, intendedSizeRaw: "50" },
      metadata: { tickSize: "0.01", negRisk: false }
    }),
    decisionId
  );
  db.prepare(
    `
      INSERT INTO order_submissions (
        id, copy_decision_id, signed_order_hash, encrypted_signed_payload_json,
        current_state, order_type, limit_price_ppm, intended_notional_raw, intended_size_raw,
        retry_count, recovery_attempts, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, 'TIMEOUT_UNKNOWN', 'FAK', '500000', '25', '50', 0, ?, ?, ?)
    `
  ).run(orderSubmissionId, decisionId, signedOrderHash, encryptedPayload(orderSubmissionId), options.recoveryAttempts ?? 0, nowIso, nowIso);
}

function breakerThresholds() {
  return {
    consecutiveRejectionsHalt: 5,
    consecutiveTimeoutUnknownHalt: 3,
    staleBookHalt: 5,
    bookSourceMismatchHalt: 3,
    clobUnavailableHalt: 3
  };
}

function encryptedPayload(orderSubmissionId: string, overrides: Record<string, string | number> = {}): string {
  return encryptSignedPayload(
    JSON.stringify({
      salt: "1",
      maker: owner,
      signer: owner,
      tokenId: "123456789",
      makerAmount: "25",
      takerAmount: "50",
      side: "BUY",
      signatureType: 0,
      timestamp: "1779451200000",
      metadata: `0x${"0".repeat(64)}`,
      builder: `0x${"0".repeat(64)}`,
      expiration: "0",
      signature: `0x${"b".repeat(130)}`,
      ...overrides
    }),
    encryptionKey,
    { aad: orderSubmissionId }
  );
}

function orderStatus(status: OrderStatusResult["status"], fills: OrderStatusResult["fills"]): OrderStatusResult {
  return { status, fills, raw: { fixture: status } };
}
