export type OrderSubmissionState =
  | "CREATED"
  | "SUBMITTING"
  | "SUBMITTED"
  | "ACK_FILLED"
  | "ACK_PARTIAL"
  | "ACK_REJECTED"
  | "TIMEOUT_UNKNOWN"
  | "CANCELLED"
  | "FAILED";

export const ORDER_SUBMISSION_STATES = [
  "CREATED",
  "SUBMITTING",
  "SUBMITTED",
  "ACK_FILLED",
  "ACK_PARTIAL",
  "ACK_REJECTED",
  "TIMEOUT_UNKNOWN",
  "CANCELLED",
  "FAILED"
] as const;

export type Transition = {
  from: OrderSubmissionState;
  to: OrderSubmissionState;
  terminal: boolean;
};

export type RetryGuardContext = {
  hashAbsent: boolean;
  samePayload: boolean;
  retryCount: number;
  recoveryAttempts: number;
  maxRecoveryAttempts: number;
  killSwitchInactive: boolean;
  preRetryGatesPassing: boolean;
};

export const LEGAL_ORDER_SUBMISSION_TRANSITIONS: Record<OrderSubmissionState, OrderSubmissionState[]> = {
  CREATED: ["SUBMITTING", "CANCELLED"],
  SUBMITTING: ["SUBMITTED", "TIMEOUT_UNKNOWN", "ACK_REJECTED", "FAILED", "CANCELLED"],
  SUBMITTED: ["ACK_FILLED", "ACK_PARTIAL", "ACK_REJECTED", "TIMEOUT_UNKNOWN"],
  ACK_FILLED: [],
  ACK_PARTIAL: [],
  ACK_REJECTED: [],
  TIMEOUT_UNKNOWN: ["SUBMITTED", "SUBMITTING", "ACK_FILLED", "ACK_PARTIAL", "ACK_REJECTED", "CANCELLED", "FAILED"],
  CANCELLED: [],
  FAILED: []
};

const terminalStates = new Set<OrderSubmissionState>(["ACK_FILLED", "ACK_PARTIAL", "ACK_REJECTED", "CANCELLED", "FAILED"]);

export function assertLegalTransition(from: OrderSubmissionState, to: OrderSubmissionState, context?: RetryGuardContext): void {
  if (terminalStates.has(from)) {
    throw new Error(`${from} is terminal`);
  }
  if (!LEGAL_ORDER_SUBMISSION_TRANSITIONS[from].includes(to)) {
    throw new Error(`Illegal order submission transition: ${from} -> ${to}`);
  }
  if (from === "TIMEOUT_UNKNOWN" && to === "SUBMITTING") {
    if (!context) throw new Error("TIMEOUT_UNKNOWN -> SUBMITTING requires retry guard context");
    const failures: string[] = [];
    if (!context.hashAbsent) failures.push("hashAbsent");
    if (!context.samePayload) failures.push("samePayload");
    if (context.retryCount >= 2) failures.push("retryCount");
    if (context.recoveryAttempts >= context.maxRecoveryAttempts) failures.push("recoveryAttempts");
    if (!context.killSwitchInactive) failures.push("killSwitchInactive");
    if (!context.preRetryGatesPassing) failures.push("preRetryGatesPassing");
    if (failures.length) {
      throw new Error(`TIMEOUT_UNKNOWN -> SUBMITTING guard failed: ${failures.join(", ")}`);
    }
  }
}

export function transitionOrderSubmissionState(
  from: OrderSubmissionState,
  to: OrderSubmissionState,
  context?: RetryGuardContext
): Transition {
  assertLegalTransition(from, to, context);
  return { from, to, terminal: terminalStates.has(to) };
}

export function planTimeoutUnknownRecovery(args: RetryGuardContext & { zeroExposureProof: boolean }):
  | {
      action: "HALT_KEEP_UNCERTAIN";
      state: "TIMEOUT_UNKNOWN";
      reason: "MAX_RECOVERY_ATTEMPTS_WITHOUT_ZERO_EXPOSURE_PROOF";
      preserveReservation: true;
      preservePayload: true;
    }
  | { action: "RETRY_ALLOWED"; state: "SUBMITTING" }
  | { action: "TERMINAL_ZERO_EXPOSURE"; state: "FAILED" } {
  if (args.zeroExposureProof) {
    return { action: "TERMINAL_ZERO_EXPOSURE", state: "FAILED" };
  }
  if (args.recoveryAttempts >= args.maxRecoveryAttempts) {
    return {
      action: "HALT_KEEP_UNCERTAIN",
      state: "TIMEOUT_UNKNOWN",
      reason: "MAX_RECOVERY_ATTEMPTS_WITHOUT_ZERO_EXPOSURE_PROOF",
      preserveReservation: true,
      preservePayload: true
    };
  }
  assertLegalTransition("TIMEOUT_UNKNOWN", "SUBMITTING", args);
  return { action: "RETRY_ALLOWED", state: "SUBMITTING" };
}
