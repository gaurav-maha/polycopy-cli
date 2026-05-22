import type { SubmitResult } from "../adapters/types.js";

export const TRANSIENT_SUBMIT_ERROR_CODES = new Set([
  "CLOB_TIMEOUT_UNKNOWN",
  "RATE_LIMIT",
  "CLOB_UNAVAILABLE",
  "INTERNAL_TIMEOUT"
]);

export const UNEXPECTED_RESTING_STATUSES = new Set(["live", "unmatched"]);

export type SubmitClassification =
  | "ACK_REJECTED"
  | "TIMEOUT_UNKNOWN"
  | "SUBMITTED_RECONCILE_NOW"
  | "SUBMITTED_WAIT"
  | "UNEXPECTED_RESTING";

export function classifySubmitResult(result: SubmitResult): SubmitClassification {
  if (!result.success) {
    return TRANSIENT_SUBMIT_ERROR_CODES.has(result.errorCode ?? "") ? "TIMEOUT_UNKNOWN" : "ACK_REJECTED";
  }
  if (result.status && UNEXPECTED_RESTING_STATUSES.has(result.status)) {
    return "UNEXPECTED_RESTING";
  }
  if (result.status === "matched") return "SUBMITTED_RECONCILE_NOW";
  if (result.status === "delayed") return "SUBMITTED_WAIT";
  return "TIMEOUT_UNKNOWN";
}

export function isAccountSetupRejection(result: SubmitResult): boolean {
  const message = `${result.errorCode ?? ""} ${result.errorMsg ?? ""}`.toLowerCase();
  return message.includes("maker address not allowed") || message.includes("deposit wallet flow");
}

export function isGeoblockRejection(result: SubmitResult): boolean {
  const message = `${result.errorCode ?? ""} ${result.errorMsg ?? ""}`.toLowerCase();
  return message.includes("geoblock") || message.includes("trading restricted") || (message.includes("region") && message.includes("vpn"));
}

export function redactSubmitResult(result: SubmitResult): Record<string, unknown> {
  return {
    success: result.success,
    errorMsg: result.errorMsg,
    errorCode: result.errorCode,
    orderID: result.orderID,
    status: result.status,
    takingAmount: result.takingAmount,
    makingAmount: result.makingAmount,
    transactionsHashes: result.transactionsHashes,
    tradeIDs: result.tradeIDs
  };
}
