import type { ClobRestAdapter, Hex, RpcAdapter, SignedClobOrder, SubmitResult } from "../adapters/types.js";
import type { SqliteDatabase } from "../db/client.js";
import { decryptSignedPayload } from "./payload-crypto.js";
import { transitionOrderSubmissionCas } from "./order-cas.js";
import { planTimeoutUnknownRecovery } from "./state-machine.js";
import { evaluateLiveCycleBreakers, haltLiveTrading, type BreakerThresholds } from "./circuit-breaker.js";
import { reconcileOrderSubmissionStatus, type ReconcileOrderSubmissionStatusResult } from "../reconcile/orders.js";
import { evaluateSignBoundaryReGate, type SignBoundaryReGateConfig } from "../risk/sign-boundary-gate.js";
import { classifySubmitResult, isAccountSetupRejection, isGeoblockRejection } from "./submit-errors.js";
import { formatSettlementReceiptWait, waitForSettlementReceipts } from "./settlement-receipts.js";
import {
  assertSignedOrderInvariants,
  expectedOrderSigner,
  signedOrderInvariantErrorReason
} from "./live-runner/signed-order-invariants.js";

type PendingOrderRow = {
  id: string;
  signed_order_hash: Hex;
  current_state: "CREATED" | "SUBMITTED" | "TIMEOUT_UNKNOWN" | "ACK_PARTIAL" | "ACK_FILLED";
  encrypted_signed_payload_json: string | null;
  retry_count: number;
  recovery_attempts: number;
  order_type: "FAK" | "FOK";
};

export type StartupOrderRecoveryResult = {
  createdCancelled: number;
  createdResumed: number;
  submittingRecovered: number;
  partialReconciled: number;
  filledVerified: number;
};

export type OrderRecoveryCycleResult = {
  startup: StartupOrderRecoveryResult;
  reconciled: number;
  retried: number;
  terminal: number;
  uncertain: number;
  halted: boolean;
  haltReason: string | null;
};

export function recoverStartupOrderStates(db: SqliteDatabase, nowIso: string): number {
  return runStartupOrderRecovery(db, { nowIso }).submittingRecovered;
}

export function runStartupOrderRecovery(
  db: SqliteDatabase,
  args: { nowIso: string }
): StartupOrderRecoveryResult {
  const result: StartupOrderRecoveryResult = {
    createdCancelled: 0,
    createdResumed: 0,
    submittingRecovered: 0,
    partialReconciled: 0,
    filledVerified: 0
  };

  const submittingRows = db
    .prepare("SELECT id FROM order_submissions WHERE current_state = 'SUBMITTING'")
    .all() as Array<{ id: string }>;
  for (const row of submittingRows) {
    transitionOrderSubmissionCas(db, {
      orderSubmissionId: row.id,
      from: "SUBMITTING",
      to: "TIMEOUT_UNKNOWN",
      action: "STARTUP_RECOVERY_UNKNOWN",
      nowIso: args.nowIso
    });
    result.submittingRecovered += 1;
  }

  return result;
}

export async function runOrderRecoveryCycle(
  db: SqliteDatabase,
  args: {
    clob: ClobRestAdapter;
    rpc: RpcAdapter;
    owner: Hex;
    funder: Hex;
    signatureType: 0 | 1 | 3;
    encryptionKey: Uint8Array;
    maxRecoveryAttempts: number;
    breakerThresholds: BreakerThresholds;
    signBoundary?: SignBoundaryReGateConfig;
    killSwitchActive: () => boolean | Promise<boolean>;
    nowIso?: string;
  }
): Promise<OrderRecoveryCycleResult> {
  const nowIso = args.nowIso ?? new Date().toISOString();
  const startup = runStartupOrderRecovery(db, { nowIso });
  const result: OrderRecoveryCycleResult = {
    startup,
    reconciled: 0,
    retried: 0,
    terminal: 0,
    uncertain: 0,
    halted: false,
    haltReason: null
  };

  if (await args.killSwitchActive()) {
    await cancelCreatedOrders(db, nowIso);
  }

  const partialOrders = db
    .prepare(
      `
        SELECT id, signed_order_hash, current_state, encrypted_signed_payload_json, retry_count, recovery_attempts, order_type
        FROM order_submissions
        WHERE current_state = 'ACK_PARTIAL'
        ORDER BY datetime(updated_at), updated_at, id
      `
    )
    .all() as PendingOrderRow[];
  for (const order of partialOrders) {
    const reconcileResult = await reconcileOrderSubmissionStatus(db, {
      clob: args.clob,
      rpc: args.rpc,
      owner: args.funder,
      orderSubmissionId: order.id,
      nowIso
    });
    if (reconcileResult.outcome === "ACK_FILLED" || reconcileResult.outcome === "ACK_PARTIAL") {
      if (reconciliationDiverged(reconcileResult)) {
        result.halted = true;
        result.haltReason = "RECONCILIATION_DIVERGENCE";
        return result;
      }
      result.startup.partialReconciled += 1;
      result.reconciled += 1;
    } else if (reconcileResult.outcome === "UNCERTAIN") {
      result.uncertain += 1;
    }
  }

  const createdOrders = db
    .prepare(
      `
        SELECT id, signed_order_hash, current_state, encrypted_signed_payload_json, retry_count, recovery_attempts, order_type
        FROM order_submissions
        WHERE current_state = 'CREATED'
        ORDER BY datetime(created_at), created_at, id
      `
    )
    .all() as PendingOrderRow[];
  for (const order of createdOrders) {
    if (await args.killSwitchActive()) continue;
    result.startup.createdResumed += 1;
    const outcome = await resumeCreatedOrder(db, { ...args, order, nowIso });
    result.retried += outcome.retried;
    result.reconciled += outcome.reconciled;
    result.terminal += outcome.terminal;
    result.uncertain += outcome.uncertain;
    if (outcome.halted) {
      result.halted = true;
      result.haltReason = outcome.haltReason;
      return result;
    }
  }

  const submitted = db
    .prepare(
      `
        SELECT id, signed_order_hash, current_state, encrypted_signed_payload_json, retry_count, recovery_attempts, order_type
        FROM order_submissions
        WHERE current_state = 'SUBMITTED'
        ORDER BY datetime(updated_at), updated_at, id
      `
    )
    .all() as PendingOrderRow[];

  for (const order of submitted) {
    const reconcileResult = await reconcileOrderSubmissionStatus(db, {
      clob: args.clob,
      rpc: args.rpc,
      owner: args.funder,
      orderSubmissionId: order.id,
      nowIso
    });
    if (reconcileResult.outcome === "UNCERTAIN") {
      result.uncertain += 1;
      const breaker = evaluateLiveCycleBreakers(db, args.breakerThresholds, {
        rejected: 0,
        timeoutUnknown: 1,
        staleAtSign: 0,
        bookSourceMismatch: 0,
        clobUnavailable: 0,
        cacheMismatch: 0,
        reconciled: 0,
        recoveryTerminal: 0
      }, nowIso);
      if (breaker.halted) {
        result.halted = true;
        result.haltReason = breaker.haltReason;
        return result;
      }
      continue;
    }
    if (reconciliationDiverged(reconcileResult)) {
      result.halted = true;
      result.haltReason = "RECONCILIATION_DIVERGENCE";
      return result;
    }
    result.reconciled += 1;
  }

  const uncertainOrders = db
    .prepare(
      `
        SELECT id, signed_order_hash, current_state, encrypted_signed_payload_json, retry_count, recovery_attempts, order_type
        FROM order_submissions
        WHERE current_state = 'TIMEOUT_UNKNOWN'
        ORDER BY datetime(updated_at), updated_at, id
      `
    )
    .all() as PendingOrderRow[];

  for (const order of uncertainOrders) {
    if (await args.killSwitchActive()) {
      continue;
    }
    const outcome = await recoverTimeoutUnknownOrder(db, { ...args, order, nowIso });
    result.reconciled += outcome.reconciled;
    result.retried += outcome.retried;
    result.terminal += outcome.terminal;
    result.uncertain += outcome.uncertain;
    if (outcome.halted) {
      result.halted = true;
      result.haltReason = outcome.haltReason;
      return result;
    }
  }

  if (result.reconciled > 0 || result.terminal > 0) {
    evaluateLiveCycleBreakers(db, args.breakerThresholds, {
      rejected: 0,
      timeoutUnknown: 0,
      staleAtSign: 0,
      bookSourceMismatch: 0,
      clobUnavailable: 0,
      cacheMismatch: 0,
      reconciled: result.reconciled,
      recoveryTerminal: result.terminal
    }, nowIso);
  }

  return result;
}

async function cancelCreatedOrders(db: SqliteDatabase, nowIso: string): Promise<void> {
  const rows = db
    .prepare("SELECT id FROM order_submissions WHERE current_state = 'CREATED'")
    .all() as Array<{ id: string }>;
  for (const row of rows) {
    transitionOrderSubmissionCas(db, {
      orderSubmissionId: row.id,
      from: "CREATED",
      to: "CANCELLED",
      action: "STARTUP_KILL_SWITCH_CANCEL",
      zeroExposureProof: true,
      errorCode: "KILL_SWITCH",
      nowIso
    });
  }
}

async function resumeCreatedOrder(
  db: SqliteDatabase,
  args: {
    clob: ClobRestAdapter;
    rpc: RpcAdapter;
    owner: Hex;
    funder: Hex;
    signatureType: 0 | 1 | 3;
    encryptionKey: Uint8Array;
    maxRecoveryAttempts: number;
    breakerThresholds: BreakerThresholds;
    signBoundary?: SignBoundaryReGateConfig;
    killSwitchActive: () => boolean | Promise<boolean>;
    order: PendingOrderRow;
    nowIso: string;
  }
): Promise<{
  reconciled: number;
  retried: number;
  terminal: number;
  uncertain: number;
  halted: boolean;
  haltReason: string | null;
}> {
  const validation = validateRecoverableSignedPayload(db, args);
  if (!validation.ok) {
    transitionOrderSubmissionCas(db, {
      orderSubmissionId: args.order.id,
      from: "CREATED",
      to: "CANCELLED",
      action: "RECOVERY_SIGNED_ORDER_INVALID",
      zeroExposureProof: true,
      errorCode: "SIGNED_ORDER_INVARIANT",
      lastError: validation.error,
      nowIso: args.nowIso
    });
    haltLiveTrading(db, "SIGNED_ORDER_INVARIANT_VIOLATION", { orderSubmissionId: args.order.id, error: validation.error }, args.nowIso);
    return { reconciled: 0, retried: 0, terminal: 1, uncertain: 0, halted: true, haltReason: "SIGNED_ORDER_INVARIANT_VIOLATION" };
  }

  transitionOrderSubmissionCas(db, {
    orderSubmissionId: args.order.id,
    from: "CREATED",
    to: "SUBMITTING",
    action: "STARTUP_RESUME_CREATED",
    nowIso: args.nowIso
  });
  if (await args.killSwitchActive()) {
    transitionOrderSubmissionCas(db, {
      orderSubmissionId: args.order.id,
      from: "SUBMITTING",
      to: "CANCELLED",
      action: "RETRY_KILL_SWITCH_CANCEL",
      zeroExposureProof: true,
      errorCode: "KILL_SWITCH",
      nowIso: args.nowIso
    });
    return { reconciled: 0, retried: 0, terminal: 1, uncertain: 0, halted: false, haltReason: null };
  }
  return submitSignedPayload(db, { ...args, fromState: "SUBMITTING" });
}

async function recoverTimeoutUnknownOrder(
  db: SqliteDatabase,
  args: {
    clob: ClobRestAdapter;
    rpc: RpcAdapter;
    owner: Hex;
    funder: Hex;
    signatureType: 0 | 1 | 3;
    encryptionKey: Uint8Array;
    maxRecoveryAttempts: number;
    breakerThresholds: BreakerThresholds;
    signBoundary?: SignBoundaryReGateConfig;
    killSwitchActive: () => boolean | Promise<boolean>;
    order: PendingOrderRow;
    nowIso: string;
  }
): Promise<{
  reconciled: number;
  retried: number;
  terminal: number;
  uncertain: number;
  halted: boolean;
  haltReason: string | null;
}> {
  const status = await args.clob.getOrderByHash(args.order.signed_order_hash);
  if (status.fills.length > 0) {
    const reconcileResult = await reconcileOrderSubmissionStatus(db, {
      clob: args.clob,
      rpc: args.rpc,
      owner: args.funder,
      orderSubmissionId: args.order.id,
      nowIso: args.nowIso
    });
    if (reconciliationDiverged(reconcileResult)) {
      return {
        reconciled: 0,
        retried: 0,
        terminal: 0,
        uncertain: 0,
        halted: true,
        haltReason: "RECONCILIATION_DIVERGENCE"
      };
    }
    return {
      reconciled: reconcileResult.outcome === "ACK_FILLED" || reconcileResult.outcome === "ACK_PARTIAL" ? 1 : 0,
      retried: 0,
      terminal: reconcileResult.outcome === "ZERO_EXPOSURE_TERMINAL" ? 1 : 0,
      uncertain: reconcileResult.outcome === "UNCERTAIN" ? 1 : 0,
      halted: false,
      haltReason: null
    };
  }

  if (status.status === "cancelled" || status.status === "failed") {
    transitionOrderSubmissionCas(db, {
      orderSubmissionId: args.order.id,
      from: "TIMEOUT_UNKNOWN",
      to: status.status === "cancelled" ? "CANCELLED" : "FAILED",
      action: `${status.status.toUpperCase()}_ZERO_EXPOSURE`,
      zeroExposureProof: true,
      nowIso: args.nowIso
    });
    return { reconciled: 0, retried: 0, terminal: 1, uncertain: 0, halted: false, haltReason: null };
  }

  const hashAbsent = status.status === "unknown";
  const preRetryGatesPassing = await passesPreRetryGates(db, args);
  const plan = planTimeoutUnknownRecovery({
    hashAbsent,
    samePayload: true,
    retryCount: args.order.retry_count,
    recoveryAttempts: args.order.recovery_attempts,
    maxRecoveryAttempts: args.maxRecoveryAttempts,
    killSwitchInactive: !(await args.killSwitchActive()),
    preRetryGatesPassing,
    zeroExposureProof: false
  });

  if (plan.action === "HALT_KEEP_UNCERTAIN") {
    haltLiveTrading(db, plan.reason, { orderSubmissionId: args.order.id }, args.nowIso);
    return { reconciled: 0, retried: 0, terminal: 0, uncertain: 1, halted: true, haltReason: plan.reason };
  }

  if (plan.action !== "RETRY_ALLOWED") {
    return { reconciled: 0, retried: 0, terminal: 0, uncertain: 1, halted: false, haltReason: null };
  }

  if (!args.order.encrypted_signed_payload_json) {
    return { reconciled: 0, retried: 0, terminal: 0, uncertain: 1, halted: false, haltReason: null };
  }

  const validation = validateRecoverableSignedPayload(db, args);
  if (!validation.ok) {
    markOrderValidationFailure(db, args.order.id, validation.error, args.nowIso);
    haltLiveTrading(db, "SIGNED_ORDER_INVARIANT_VIOLATION", { orderSubmissionId: args.order.id, error: validation.error }, args.nowIso);
    return { reconciled: 0, retried: 0, terminal: 0, uncertain: 1, halted: true, haltReason: "SIGNED_ORDER_INVARIANT_VIOLATION" };
  }

  transitionOrderSubmissionCas(db, {
    orderSubmissionId: args.order.id,
    from: "TIMEOUT_UNKNOWN",
    to: "SUBMITTING",
    action: "RETRY_SAME_PAYLOAD",
    incrementRecoveryAttempts: true,
    incrementRetryCount: true,
    nowIso: args.nowIso,
    retryGuard: {
      hashAbsent,
      samePayload: true,
      retryCount: args.order.retry_count,
      recoveryAttempts: args.order.recovery_attempts,
      maxRecoveryAttempts: args.maxRecoveryAttempts,
      killSwitchInactive: !(await args.killSwitchActive()),
      preRetryGatesPassing
    }
  });
  if (await args.killSwitchActive()) {
    transitionOrderSubmissionCas(db, {
      orderSubmissionId: args.order.id,
      from: "SUBMITTING",
      to: "CANCELLED",
      action: "RETRY_KILL_SWITCH_CANCEL",
      zeroExposureProof: true,
      errorCode: "KILL_SWITCH",
      nowIso: args.nowIso
    });
    return { reconciled: 0, retried: 0, terminal: 1, uncertain: 0, halted: false, haltReason: null };
  }

  return submitSignedPayload(db, { ...args, fromState: "SUBMITTING" });
}

async function passesPreRetryGates(
  db: SqliteDatabase,
  args: {
    clob: ClobRestAdapter;
    signBoundary?: SignBoundaryReGateConfig;
    order: PendingOrderRow;
    nowIso: string;
  }
): Promise<boolean> {
  if (!args.signBoundary) return true;
  const decision = readCopyDecisionForSubmission(db, args.order.id);
  if (!decision) return false;
  const reGate = await evaluateSignBoundaryReGate(
    {
      tokenId: decision.tokenId,
      side: decision.side,
      leaderPricePpm: decision.leaderPricePpm,
      approvedNotionalRaw: BigInt(decision.approvedNotionalRaw),
      tickSizePpm: decision.tickSizePpm,
      nowMs: Date.parse(args.nowIso),
      clob: args.clob
    },
    args.signBoundary
  );
  return reGate.ok;
}

async function submitSignedPayload(
  db: SqliteDatabase,
  args: {
    clob: ClobRestAdapter;
    rpc: RpcAdapter;
    owner: Hex;
    funder: Hex;
    signatureType: 0 | 1 | 3;
    encryptionKey: Uint8Array;
    breakerThresholds: BreakerThresholds;
    order: PendingOrderRow;
    fromState: "SUBMITTING";
    nowIso: string;
  }
): Promise<{
  reconciled: number;
  retried: number;
  terminal: number;
  uncertain: number;
  halted: boolean;
  haltReason: string | null;
}> {
  if (!args.order.encrypted_signed_payload_json) {
    return { reconciled: 0, retried: 0, terminal: 0, uncertain: 1, halted: false, haltReason: null };
  }

  const payloadJson = decryptSignedPayload(args.order.encrypted_signed_payload_json, args.encryptionKey, {
    aad: args.order.id
  });
  const signedOrder: SignedClobOrder = {
    orderHash: args.order.signed_order_hash,
    payload: JSON.parse(payloadJson)
  };
  const validationError = validateSignedOrderForSubmission(db, args.order.id, signedOrder, {
    owner: args.owner,
    funder: args.funder,
    signatureType: args.signatureType
  });
  if (validationError) {
    transitionOrderSubmissionCas(db, {
      orderSubmissionId: args.order.id,
      from: args.fromState,
      to: "TIMEOUT_UNKNOWN",
      action: "RECOVERY_SIGNED_ORDER_INVALID",
      errorCode: "SIGNED_ORDER_INVARIANT",
      lastError: validationError,
      nowIso: args.nowIso
    });
    haltLiveTrading(db, "SIGNED_ORDER_INVARIANT_VIOLATION", { orderSubmissionId: args.order.id, error: validationError }, args.nowIso);
    return { reconciled: 0, retried: 0, terminal: 0, uncertain: 1, halted: true, haltReason: "SIGNED_ORDER_INVARIANT_VIOLATION" };
  }

  let submitResult: SubmitResult;
  try {
    submitResult = await args.clob.submitOrder({
      signedOrder,
      orderType: args.order.order_type,
      postOnly: false
    });
  } catch (error) {
    transitionOrderSubmissionCas(db, {
      orderSubmissionId: args.order.id,
      from: args.fromState,
      to: "TIMEOUT_UNKNOWN",
      action: "RETRY_THROWN_UNKNOWN",
      errorCode: "SUBMIT_THROWN",
      lastError: stringifyError(error),
      nowIso: args.nowIso
    });
    const breaker = evaluateLiveCycleBreakers(db, args.breakerThresholds, {
      rejected: 0,
      timeoutUnknown: 1,
      staleAtSign: 0,
      bookSourceMismatch: 0,
      clobUnavailable: 0,
      cacheMismatch: 0,
      reconciled: 0,
      recoveryTerminal: 0
    }, args.nowIso);
    if (breaker.halted) {
      return { reconciled: 0, retried: 1, terminal: 0, uncertain: 1, halted: true, haltReason: breaker.haltReason };
    }
    return { reconciled: 0, retried: 1, terminal: 0, uncertain: 1, halted: false, haltReason: null };
  }

  if (!submitResult.success) {
    const classification = classifySubmitResult(submitResult);
    const transient = classification === "TIMEOUT_UNKNOWN";
    transitionOrderSubmissionCas(db, {
      orderSubmissionId: args.order.id,
      from: args.fromState,
      to: transient ? "TIMEOUT_UNKNOWN" : "ACK_REJECTED",
      action: transient ? "RETRY_TIMEOUT_UNKNOWN" : "RETRY_REJECTED",
      zeroExposureProof: !transient,
      errorCode: submitResult.errorCode ?? null,
      lastError: submitResult.errorMsg,
      nowIso: args.nowIso
    });
    if (transient) {
      const breaker = evaluateLiveCycleBreakers(db, args.breakerThresholds, {
        rejected: 0,
        timeoutUnknown: 0,
        staleAtSign: 0,
        bookSourceMismatch: 0,
        clobUnavailable: submitResult.errorCode === "CLOB_UNAVAILABLE" ? 1 : 0,
        cacheMismatch: 0,
        reconciled: 0,
        recoveryTerminal: 0
      }, args.nowIso);
      if (breaker.halted) {
        return { reconciled: 0, retried: 1, terminal: 0, uncertain: 1, halted: true, haltReason: breaker.haltReason };
      }
    }
    if (isAccountSetupRejection(submitResult)) {
      haltLiveTrading(db, "CLOB_ACCOUNT_NOT_ALLOWED", { orderSubmissionId: args.order.id }, args.nowIso);
      return { reconciled: 0, retried: 1, terminal: 1, uncertain: 0, halted: true, haltReason: "CLOB_ACCOUNT_NOT_ALLOWED" };
    }
    if (isGeoblockRejection(submitResult)) {
      haltLiveTrading(db, "CLOB_GEO_BLOCKED", { orderSubmissionId: args.order.id }, args.nowIso);
      return { reconciled: 0, retried: 1, terminal: 1, uncertain: 0, halted: true, haltReason: "CLOB_GEO_BLOCKED" };
    }
    return { reconciled: 0, retried: 1, terminal: transient ? 0 : 1, uncertain: transient ? 1 : 0, halted: false, haltReason: null };
  }

  const classification = classifySubmitResult(submitResult);
  transitionOrderSubmissionCas(db, {
    orderSubmissionId: args.order.id,
    from: args.fromState,
    to: "SUBMITTED",
    action: "RETRY_SUBMIT_ACK",
    nowIso: args.nowIso
  });

  if (classification === "UNEXPECTED_RESTING") {
    transitionOrderSubmissionCas(db, {
      orderSubmissionId: args.order.id,
      from: "SUBMITTED",
      to: "TIMEOUT_UNKNOWN",
      action: "RETRY_UNEXPECTED_RESTING_HALT_PENDING_CANCEL",
      errorCode: "CLOB_LIVE_STATUS_UNEXPECTED",
      nowIso: args.nowIso
    });
    haltLiveTrading(db, "CLOB_LIVE_STATUS_UNEXPECTED", { orderSubmissionId: args.order.id }, args.nowIso);
    try {
      await args.clob.cancelByHash(signedOrder.orderHash);
    } catch (error) {
      recordCancelFailure(db, args.order.id, stringifyError(error), args.nowIso);
    }
    return { reconciled: 0, retried: 1, terminal: 0, uncertain: 1, halted: true, haltReason: "CLOB_LIVE_STATUS_UNEXPECTED" };
  }

  if (classification === "SUBMITTED_WAIT") {
    return { reconciled: 0, retried: 1, terminal: 0, uncertain: 0, halted: false, haltReason: null };
  }

  if (classification !== "SUBMITTED_RECONCILE_NOW") {
    return { reconciled: 0, retried: 1, terminal: 0, uncertain: 1, halted: false, haltReason: null };
  }

  const receiptWait = await waitForSettlementReceipts(args.rpc, submitResult.transactionsHashes);
  if (!receiptWait.ready) {
    recordSettlementReceiptPending(db, args.order.id, formatSettlementReceiptWait(receiptWait), args.nowIso);
    return { reconciled: 0, retried: 1, terminal: 0, uncertain: 1, halted: false, haltReason: null };
  }

  const reconcileResult = await reconcileOrderSubmissionStatus(db, {
    clob: args.clob,
    rpc: args.rpc,
    owner: args.funder,
    orderSubmissionId: args.order.id,
    nowIso: args.nowIso
  });
  if (reconciliationDiverged(reconcileResult)) {
    return { reconciled: 0, retried: 1, terminal: 0, uncertain: 0, halted: true, haltReason: "RECONCILIATION_DIVERGENCE" };
  }
  return {
    reconciled: reconcileResult.outcome === "ACK_FILLED" || reconcileResult.outcome === "ACK_PARTIAL" ? 1 : 0,
    retried: 1,
    terminal: reconcileResult.outcome === "ZERO_EXPOSURE_TERMINAL" ? 1 : 0,
    uncertain: reconcileResult.outcome === "UNCERTAIN" ? 1 : 0,
    halted: false,
    haltReason: null
  };
}

function recordCancelFailure(db: SqliteDatabase, orderSubmissionId: string, errorMessage: string, nowIso: string): void {
  db.prepare(
    `
      UPDATE order_submissions
      SET last_error = ?,
          updated_at = ?
      WHERE id = ?
    `
  ).run(`cancelByHash failed after unexpected resting status: ${errorMessage}`, nowIso, orderSubmissionId);
}

function recordSettlementReceiptPending(db: SqliteDatabase, orderSubmissionId: string, errorMessage: string, nowIso: string): void {
  db.prepare(
    `
      UPDATE order_submissions
      SET last_error = ?,
          updated_at = ?
      WHERE id = ?
    `
  ).run(errorMessage, nowIso, orderSubmissionId);
}

function reconciliationDiverged(result: ReconcileOrderSubmissionStatusResult): boolean {
  return "reconciliation" in result && result.reconciliation.status === "DIVERGED";
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateRecoverableSignedPayload(
  db: SqliteDatabase,
  args: {
    owner: Hex;
    funder: Hex;
    signatureType: 0 | 1 | 3;
    encryptionKey: Uint8Array;
    order: PendingOrderRow;
  }
): { ok: true } | { ok: false; error: string } {
  try {
    if (!args.order.encrypted_signed_payload_json) {
      throw new Error("missing encrypted signed payload");
    }
    const payloadJson = decryptSignedPayload(args.order.encrypted_signed_payload_json, args.encryptionKey, {
      aad: args.order.id
    });
    const signedOrder: SignedClobOrder = {
      orderHash: args.order.signed_order_hash,
      payload: JSON.parse(payloadJson)
    };
    const error = validateSignedOrderForSubmission(db, args.order.id, signedOrder, args);
    if (error) return { ok: false, error };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: signedOrderInvariantErrorReason(error, "SIGNED_ORDER_VALIDATION_FAILED") };
  }
}

function validateSignedOrderForSubmission(
  db: SqliteDatabase,
  orderSubmissionId: string,
  signedOrder: SignedClobOrder,
  account: { owner: Hex; funder: Hex; signatureType: 0 | 1 | 3 }
): string | null {
  try {
    const decision = readSignedOrderDecisionForSubmission(db, orderSubmissionId);
    if (!decision) {
      throw new Error(`copy decision not found for order submission ${orderSubmissionId}`);
    }
    assertSignedOrderInvariants(
      decision,
      {
        expectedMaker: account.funder,
        expectedSigner: expectedOrderSigner(account),
        expectedSignatureType: account.signatureType
      },
      signedOrder
    );
    return null;
  } catch (error) {
    return signedOrderInvariantErrorReason(error, "SIGNED_ORDER_VALIDATION_FAILED");
  }
}

function markOrderValidationFailure(
  db: SqliteDatabase,
  orderSubmissionId: string,
  error: string,
  nowIso: string
): void {
  db.prepare(
    `
      UPDATE order_submissions
      SET last_error = ?,
          updated_at = ?
      WHERE id = ?
    `
  ).run(error, nowIso, orderSubmissionId);
}

function readSignedOrderDecisionForSubmission(
  db: SqliteDatabase,
  orderSubmissionId: string
): {
  tokenId: string;
  side: "BUY" | "SELL";
  approvedNotionalRaw: bigint;
  intendedSizeRaw: bigint;
  limitPricePpm: number;
} | null {
  const row = db
    .prepare(
      `
        SELECT cd.token_id, cd.side, cd.approved_copy_notional_raw, os.intended_size_raw, os.limit_price_ppm
        FROM order_submissions os
        JOIN copy_decisions cd ON cd.id = os.copy_decision_id
        WHERE os.id = ?
      `
    )
    .get(orderSubmissionId) as
    | { token_id: string; side: "BUY" | "SELL"; approved_copy_notional_raw: string; intended_size_raw: string; limit_price_ppm: string }
    | undefined;
  if (!row) return null;
  return {
    tokenId: row.token_id,
    side: row.side,
    approvedNotionalRaw: BigInt(row.approved_copy_notional_raw),
    intendedSizeRaw: BigInt(row.intended_size_raw),
    limitPricePpm: Number(row.limit_price_ppm)
  };
}

function readCopyDecisionForSubmission(
  db: SqliteDatabase,
  orderSubmissionId: string
): {
  tokenId: string;
  side: "BUY" | "SELL";
  leaderPricePpm: number;
  approvedNotionalRaw: string;
  tickSizePpm: number;
} | null {
  const row = db
    .prepare(
      `
        SELECT cd.token_id, cd.side, cd.approved_copy_notional_raw, cd.gate_snapshot_json
        FROM order_submissions os
        JOIN copy_decisions cd ON cd.id = os.copy_decision_id
        WHERE os.id = ?
      `
    )
    .get(orderSubmissionId) as
    | { token_id: string; side: "BUY" | "SELL"; approved_copy_notional_raw: string; gate_snapshot_json: string }
    | undefined;
  if (!row) return null;
  const snapshot = JSON.parse(row.gate_snapshot_json) as Record<string, unknown>;
  const book = snapshot.book as Record<string, unknown> | undefined;
  const metadata = snapshot.metadata as Record<string, unknown> | undefined;
  const leaderPricePpm =
    typeof snapshot.leaderPricePpm === "number"
      ? snapshot.leaderPricePpm
      : typeof book?.vwapPpm === "number"
        ? book.vwapPpm
        : null;
  const tickSize = typeof metadata?.tickSize === "string" ? metadata.tickSize : null;
  if (leaderPricePpm === null || tickSize === null) return null;
  return {
    tokenId: row.token_id,
    side: row.side,
    leaderPricePpm,
    approvedNotionalRaw: row.approved_copy_notional_raw,
    tickSizePpm: Math.round(Number.parseFloat(tickSize) * 1_000_000)
  };
}
