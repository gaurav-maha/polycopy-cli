import {
  LEGAL_ORDER_SUBMISSION_TRANSITIONS,
  ORDER_SUBMISSION_STATES,
  assertLegalTransition,
  planTimeoutUnknownRecovery,
  transitionOrderSubmissionState
} from "../../src/execution/state-machine.js";

const retryContext = {
  hashAbsent: true,
  samePayload: true,
  retryCount: 0,
  recoveryAttempts: 1,
  maxRecoveryAttempts: 5,
  killSwitchInactive: true,
  preRetryGatesPassing: true
};

describe("order submission state machine", () => {
  it("exports the contract order states and legal transitions", () => {
    expect(ORDER_SUBMISSION_STATES).toEqual([
      "CREATED",
      "SUBMITTING",
      "SUBMITTED",
      "ACK_FILLED",
      "ACK_PARTIAL",
      "ACK_REJECTED",
      "TIMEOUT_UNKNOWN",
      "CANCELLED",
      "FAILED"
    ]);
    expect(LEGAL_ORDER_SUBMISSION_TRANSITIONS).toEqual({
      CREATED: ["SUBMITTING", "CANCELLED"],
      SUBMITTING: ["SUBMITTED", "TIMEOUT_UNKNOWN", "ACK_REJECTED", "FAILED", "CANCELLED"],
      SUBMITTED: ["ACK_FILLED", "ACK_PARTIAL", "ACK_REJECTED", "TIMEOUT_UNKNOWN"],
      ACK_FILLED: [],
      ACK_PARTIAL: [],
      ACK_REJECTED: [],
      TIMEOUT_UNKNOWN: ["SUBMITTED", "SUBMITTING", "ACK_FILLED", "ACK_PARTIAL", "ACK_REJECTED", "CANCELLED", "FAILED"],
      CANCELLED: [],
      FAILED: []
    });
  });

  it("throws for illegal transitions", () => {
    expect(() => assertLegalTransition("CREATED", "ACK_FILLED")).toThrow(
      /Illegal order submission transition: CREATED -> ACK_FILLED/
    );
  });

  it("allows CREATED -> SUBMITTING", () => {
    expect(transitionOrderSubmissionState("CREATED", "SUBMITTING")).toEqual({
      from: "CREATED",
      to: "SUBMITTING",
      terminal: false
    });
  });

  it("keeps ACK_REJECTED terminal", () => {
    expect(() => assertLegalTransition("ACK_REJECTED", "SUBMITTING")).toThrow(/ACK_REJECTED is terminal/);
  });

  it("requires every guarded retry condition for TIMEOUT_UNKNOWN -> SUBMITTING", () => {
    const guardFailures = [
      ["hashAbsent", false],
      ["samePayload", false],
      ["retryCount", 2],
      ["recoveryAttempts", 5],
      ["killSwitchInactive", false],
      ["preRetryGatesPassing", false]
    ] as const;

    for (const [field, value] of guardFailures) {
      expect(() =>
        assertLegalTransition("TIMEOUT_UNKNOWN", "SUBMITTING", {
          ...retryContext,
          [field]: value
        })
      ).toThrow(new RegExp(field));
    }

    expect(() => assertLegalTransition("TIMEOUT_UNKNOWN", "SUBMITTING", retryContext)).not.toThrow();
  });

  it("halts and keeps TIMEOUT_UNKNOWN uncertain when max recovery attempts lack zero-exposure proof", () => {
    expect(
      planTimeoutUnknownRecovery({
        ...retryContext,
        recoveryAttempts: 5,
        maxRecoveryAttempts: 5,
        zeroExposureProof: false
      })
    ).toEqual({
      action: "HALT_KEEP_UNCERTAIN",
      state: "TIMEOUT_UNKNOWN",
      reason: "MAX_RECOVERY_ATTEMPTS_WITHOUT_ZERO_EXPOSURE_PROOF",
      preserveReservation: true,
      preservePayload: true
    });
  });
});
