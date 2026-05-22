import type { ClobRestAdapter, Hex, RpcAdapter, SignedClobOrder, SubmitResult } from "../../adapters/types.js";
import { classifySubmitResult, isAccountSetupRejection, isGeoblockRejection, redactSubmitResult } from "../submit-errors.js";
import type { SqliteDatabase } from "../../db/client.js";
import { transitionOrderSubmissionCas } from "../order-cas.js";
import { cleanupQueueOverflowCreatedRows } from "../queue.js";
import { reconcileOrderSubmissionStatus, type ReconcileOrderSubmissionStatusResult } from "../../reconcile/orders.js";
import { formatSettlementReceiptWait, waitForSettlementReceipts } from "../settlement-receipts.js";
import {
  evaluateSignBoundaryReGate,
  type SignBoundaryReGateConfig
} from "../../risk/sign-boundary-gate.js";
import { assertBuyBalanceCoverage, assertSellInventoryCoverage } from "./balance-gate.js";
import {
  haltLive,
  markDecisionError,
  prepareDecision,
  readEligibleDecisions,
  refreshPreparedBuyFeeHeadroom,
  skipDecision,
  stringifyError
} from "./decisions.js";
import {
  createOutboxRow,
  orderSubmissionIdFor,
  reservationIdFor
} from "./outbox.js";
import type { LiveOrderSigner, LiveTradingCycleResult } from "./types.js";
import {
  assertSignedOrderInvariants,
  expectedOrderSigner,
  hasSignedOrderInvariantCode,
  signedOrderInvariantErrorReason
} from "./signed-order-invariants.js";

// Live submission supports BUY and SELL copy decisions when eligible in SQLite.
export async function runLiveTradingCycle(
  db: SqliteDatabase,
  args: {
    clob: ClobRestAdapter;
    signer: LiveOrderSigner;
    rpc: RpcAdapter;
    owner: Hex;
    funder: Hex;
    signatureType: 0 | 1 | 3;
    encryptionKey: Uint8Array;
    maxPendingSubmissions: number;
    maxOneLiveOrder: boolean;
    balanceMismatchToleranceRaw: string;
    maxPositionAgeMs?: number;
    nowMs?: number;
    nowIso?: string;
    leaders?: Hex[];
    clobCacheMaxAgeMs?: number;
    signBoundary?: SignBoundaryReGateConfig;
    settlementReceiptWaitMs?: number;
    settlementReceiptPollMs?: number;
    killSwitchActive: () => boolean | Promise<boolean>;
  }
): Promise<LiveTradingCycleResult> {
  const nowMs = args.nowMs ?? Date.now();
  const nowIso = args.nowIso ?? new Date(nowMs).toISOString();
  const result: LiveTradingCycleResult = {
    considered: 0,
    outboxed: 0,
    submitted: 0,
    reconciled: 0,
    rejected: 0,
    timeoutUnknown: 0,
    staleAtSign: 0,
    cacheMismatch: 0,
    bookSourceMismatch: 0,
    clobUnavailable: 0,
    skipped: 0,
    errors: 0,
    halted: false,
    haltReason: null,
    orderSubmissionIds: []
  };

  const decisions = readEligibleDecisions(db, {
    leaders: args.leaders,
    limit: args.maxOneLiveOrder ? 1 : args.maxPendingSubmissions
  });
  for (const decision of decisions) {
    result.considered += 1;
    if (await args.killSwitchActive()) {
      skipDecision(db, decision.id, "KILL_SWITCH", nowIso);
      result.skipped += 1;
      continue;
    }

    const prepared = prepareDecision(decision);
    const maxPositionAgeMs = args.maxPositionAgeMs ?? 300_000;
    let userPusdBalanceRaw: bigint | undefined;

    const overflow = cleanupQueueOverflowCreatedRows(db, {
      maxPendingSubmissions: args.maxPendingSubmissions,
      incomingDecisionId: decision.id,
      nowIso
    });
    if (overflow.currentDecisionSkipped) {
      result.skipped += 1;
      continue;
    }

    if (args.signBoundary) {
      const reGate = await evaluateSignBoundaryReGate(
        {
          tokenId: prepared.token_id,
          side: prepared.side,
          leaderPricePpm: prepared.leaderPricePpm,
          approvedNotionalRaw: prepared.approvedNotionalRaw,
          tickSizePpm: prepared.tickSizePpm,
          nowMs,
          clob: args.clob
        },
        args.signBoundary
      );
      if (!reGate.ok) {
        skipDecision(db, decision.id, reGate.skipReason, nowIso, reGate.signBoundarySnapshot);
        result.staleAtSign += 1;
        result.skipped += 1;
        continue;
      }
      prepared.intendedSizeRaw = reGate.intendedSizeRaw;
      prepared.limitPricePpm = reGate.limitPricePpm;
      refreshPreparedBuyFeeHeadroom(prepared);
    }

    try {
      if (prepared.side === "BUY") {
        const balance = await assertBuyBalanceCoverage(db, {
          clob: args.clob,
          rpc: args.rpc,
          funder: args.funder,
          spender: prepared.contract_address,
          signatureType: args.signatureType,
          currentOrderRaw: prepared.approvedNotionalRaw,
          currentFeeHeadroomRaw: prepared.feeHeadroomRaw,
          toleranceRaw: BigInt(args.balanceMismatchToleranceRaw),
          clobCacheMaxAgeMs: args.clobCacheMaxAgeMs ?? 60_000,
          nowMs
        });
        userPusdBalanceRaw = balance.onchainPusdRaw;
      } else {
        await assertSellInventoryCoverage(db, {
          rpc: args.rpc,
          owner: args.funder,
          tokenId: prepared.token_id,
          currentOrderSizeRaw: prepared.intendedSizeRaw,
          maxPositionAgeMs,
          nowMs
        });
      }
    } catch (error) {
      markDecisionError(db, decision.id, preSignGateErrorReason(error), nowIso);
      result.errors += 1;
      if (prepared.side === "BUY") result.cacheMismatch += 1;
      continue;
    }

    let signedOrder: SignedClobOrder;
    try {
      signedOrder = await args.signer.signMarketOrder({
        tokenId: prepared.token_id,
        side: prepared.side,
        approvedNotionalRaw: prepared.approvedNotionalRaw,
        intendedSizeRaw: prepared.intendedSizeRaw,
        limitPricePpm: prepared.limitPricePpm,
        orderType: prepared.orderType,
        tickSize: prepared.tickSize,
        negRisk: prepared.negRisk,
        userPusdBalanceRaw
      });
      const signedAmounts = assertSignedOrderInvariants(
        {
          tokenId: prepared.token_id,
          side: prepared.side,
          approvedNotionalRaw: prepared.approvedNotionalRaw,
          intendedSizeRaw: prepared.intendedSizeRaw,
          limitPricePpm: prepared.limitPricePpm
        },
        {
          expectedMaker: args.funder,
          expectedSigner: expectedOrderSigner({
            owner: args.owner,
            funder: args.funder,
            signatureType: args.signatureType
          }),
          expectedSignatureType: args.signatureType
        },
        signedOrder
      );
      prepared.intendedSizeRaw = prepared.side === "BUY" ? signedAmounts.takerAmount : signedAmounts.makerAmount;
    } catch (error) {
      markDecisionError(db, decision.id, signOrValidateErrorReason(error), nowIso);
      result.errors += 1;
      continue;
    }

    let orderSubmissionId: string;
    try {
      orderSubmissionId = createOutboxRow(db, {
        decision: prepared,
        signedOrder,
        encryptionKey: args.encryptionKey,
        nowIso,
        reservationId: reservationIdFor(decision.id),
        orderSubmissionId: orderSubmissionIdFor(decision.id)
      });
      result.outboxed += 1;
      result.orderSubmissionIds.push(orderSubmissionId);
    } catch (error) {
      markDecisionError(db, decision.id, `OUTBOX_FAILED: ${stringifyError(error)}`, nowIso);
      result.errors += 1;
      continue;
    }

    transitionOrderSubmissionCas(db, {
      orderSubmissionId,
      from: "CREATED",
      to: "SUBMITTING",
      action: "SUBMIT_START",
      nowIso
    });

    if (await args.killSwitchActive()) {
      transitionOrderSubmissionCas(db, {
        orderSubmissionId,
        from: "SUBMITTING",
        to: "CANCELLED",
        action: "PRE_SUBMIT_KILL_SWITCH",
        zeroExposureProof: true,
        errorCode: "KILL_SWITCH",
        nowIso
      });
      result.skipped += 1;
      continue;
    }

    try {
      if (prepared.side === "BUY") {
        await assertBuyBalanceCoverage(db, {
          clob: args.clob,
          rpc: args.rpc,
          funder: args.funder,
          spender: prepared.contract_address,
          signatureType: args.signatureType,
          currentOrderRaw: 0n,
          toleranceRaw: BigInt(args.balanceMismatchToleranceRaw),
          clobCacheMaxAgeMs: args.clobCacheMaxAgeMs ?? 60_000,
          nowMs
        });
      } else {
        await assertSellInventoryCoverage(db, {
          rpc: args.rpc,
          owner: args.funder,
          tokenId: prepared.token_id,
          currentOrderSizeRaw: 0n,
          maxPositionAgeMs,
          nowMs
        });
      }
    } catch (error) {
      transitionOrderSubmissionCas(db, {
        orderSubmissionId,
        from: "SUBMITTING",
        to: "CANCELLED",
        action: "PRE_SUBMIT_GATE_FAILED",
        zeroExposureProof: true,
        errorCode: prepared.side === "BUY" ? "CACHE_MISMATCH" : "NO_INVENTORY",
        lastError: stringifyError(error),
        nowIso
      });
      result.cacheMismatch += 1;
      result.skipped += 1;
      continue;
    }

    let submitResult: SubmitResult;
    try {
      submitResult = await args.clob.submitOrder({
        signedOrder,
        orderType: prepared.orderType,
        postOnly: false
      });
    } catch (error) {
      transitionOrderSubmissionCas(db, {
        orderSubmissionId,
        from: "SUBMITTING",
        to: "TIMEOUT_UNKNOWN",
        action: "SUBMIT_THROWN_UNKNOWN",
        errorCode: "SUBMIT_THROWN",
        lastError: stringifyError(error),
        nowIso
      });
      result.timeoutUnknown += 1;
      continue;
    }

    const classification = classifySubmitResult(submitResult);
    if (classification === "ACK_REJECTED") {
      transitionOrderSubmissionCas(db, {
        orderSubmissionId,
        from: "SUBMITTING",
        to: "ACK_REJECTED",
        action: "SUBMIT_REJECTED",
        zeroExposureProof: true,
        errorCode: submitResult.errorCode ?? "CLOB_REJECT_SEMANTIC",
        responseJsonRedacted: JSON.stringify(redactSubmitResult(submitResult)),
        lastError: submitResult.errorMsg,
        nowIso
      });
      result.rejected += 1;
      if (isAccountSetupRejection(submitResult)) {
        haltLive(db, "CLOB_ACCOUNT_NOT_ALLOWED", orderSubmissionId, nowIso);
        result.halted = true;
        result.haltReason = "CLOB_ACCOUNT_NOT_ALLOWED";
        return result;
      }
      if (isGeoblockRejection(submitResult)) {
        haltLive(db, "CLOB_GEO_BLOCKED", orderSubmissionId, nowIso);
        result.halted = true;
        result.haltReason = "CLOB_GEO_BLOCKED";
        return result;
      }
      continue;
    }

    if (classification === "TIMEOUT_UNKNOWN") {
      transitionOrderSubmissionCas(db, {
        orderSubmissionId,
        from: "SUBMITTING",
        to: "TIMEOUT_UNKNOWN",
        action: "SUBMIT_TIMEOUT_UNKNOWN",
        errorCode: submitResult.errorCode ?? "CLOB_TIMEOUT_UNKNOWN",
        responseJsonRedacted: JSON.stringify(redactSubmitResult(submitResult)),
        lastError: submitResult.errorMsg,
        nowIso
      });
      if (submitResult.errorCode === "CLOB_UNAVAILABLE") {
        result.clobUnavailable += 1;
      }
      result.timeoutUnknown += 1;
      continue;
    }

    transitionOrderSubmissionCas(db, {
      orderSubmissionId,
      from: "SUBMITTING",
      to: "SUBMITTED",
      action: "SUBMIT_ACK",
      responseJsonRedacted: JSON.stringify(redactSubmitResult(submitResult)),
      nowIso
    });
    result.submitted += 1;

    if (classification === "UNEXPECTED_RESTING") {
      transitionOrderSubmissionCas(db, {
        orderSubmissionId,
        from: "SUBMITTED",
        to: "TIMEOUT_UNKNOWN",
        action: "UNEXPECTED_RESTING_HALT_PENDING_CANCEL",
        errorCode: "CLOB_LIVE_STATUS_UNEXPECTED",
        nowIso
      });
      haltLive(db, "CLOB_LIVE_STATUS_UNEXPECTED", orderSubmissionId, nowIso);
      result.halted = true;
      result.haltReason = "CLOB_LIVE_STATUS_UNEXPECTED";
      try {
        await args.clob.cancelByHash(signedOrder.orderHash);
      } catch (error) {
        recordCancelFailure(db, orderSubmissionId, stringifyError(error), nowIso);
        result.timeoutUnknown += 1;
        return result;
      }
      const reconcileResult = await reconcileOrderSubmissionStatus(db, {
        clob: args.clob,
        rpc: args.rpc,
        owner: args.funder,
        orderSubmissionId,
        nowIso
      });
      if (reconcileResult.outcome === "UNCERTAIN") {
        result.timeoutUnknown += 1;
      } else {
        result.reconciled += 1;
      }
      return result;
    }

    if (classification === "SUBMITTED_RECONCILE_NOW") {
      const receiptWait = await waitForSettlementReceipts(args.rpc, submitResult.transactionsHashes, {
        timeoutMs: args.settlementReceiptWaitMs,
        pollMs: args.settlementReceiptPollMs
      });
      if (!receiptWait.ready) {
        recordSettlementReceiptPending(db, orderSubmissionId, formatSettlementReceiptWait(receiptWait), nowIso);
        result.timeoutUnknown += 1;
        continue;
      }
      const reconcileResult = await reconcileOrderSubmissionStatus(db, {
        clob: args.clob,
        rpc: args.rpc,
        owner: args.funder,
        orderSubmissionId,
        nowIso
      });
      if (reconcileResult.outcome === "UNCERTAIN") {
        result.timeoutUnknown += 1;
      } else if (reconciliationDiverged(reconcileResult)) {
        result.halted = true;
        result.haltReason = "RECONCILIATION_DIVERGENCE";
        return result;
      } else {
        result.reconciled += 1;
      }
    }
  }

  return result;
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

function signOrValidateErrorReason(error: unknown): string {
  return signedOrderInvariantErrorReason(error, "SIGN_OR_VALIDATE_FAILED");
}

function preSignGateErrorReason(error: unknown): string {
  const message = stringifyError(error);
  return hasSignedOrderInvariantCode(message) || message.startsWith("INSUFFICIENT_PUSD_AVAILABLE:")
    ? message
    : `PRE_SIGN_GATE_FAILED: ${message}`;
}
